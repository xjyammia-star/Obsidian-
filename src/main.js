const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const Store = require('electron-store')

const store = new Store()
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 600,
    title: 'Obsidian 管理工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ── 选择知识库 ──
ipcMain.handle('select-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: '选择你的 Obsidian 知识库文件夹'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('vaultPath', result.filePaths[0])
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})

// ── 获取知识库路径 ──
ipcMain.handle('get-vault-path', () => store.get('vaultPath', null))

// ── 知识库统计 ──
ipcMain.handle('get-vault-stats', async (event, vaultPath) => {
  try { return { success: true, stats: scanDirectory(vaultPath) } }
  catch (err) { return { success: false, error: err.message } }
})

// ── 搜索文件（支持多条件）──
ipcMain.handle('search-files', async (event, { vaultPath, query, fileTypes, dateFrom, dateTo, sortBy }) => {
  try {
    // 文件类型扩展名映射
    const typeExtMap = {
      md:    ['.md'],
      pdf:   ['.pdf'],
      image: ['.png','.jpg','.jpeg','.gif','.webp'],
      video: ['.mp4','.mov','.avi','.mkv','.webm','.m4v'],
      other: null
    }
    const knownExts = ['.md','.pdf','.png','.jpg','.jpeg','.gif','.webp','.mp4','.mov','.avi','.mkv','.webm','.m4v']

    // 确定要扫描的文件类型
    const hasTypeFilter = fileTypes && fileTypes.length > 0 && !fileTypes.includes('all')
    let allowedExts = null
    if (hasTypeFilter) {
      allowedExts = new Set()
      for (const t of fileTypes) {
        if (t === 'other') { allowedExts = null; break } // other 需要特殊处理
        if (typeExtMap[t]) typeExtMap[t].forEach(e => allowedExts.add(e))
      }
    }
    const includeOther = hasTypeFilter && fileTypes.includes('other')

    // 日期范围
    const from = dateFrom ? new Date(dateFrom + 'T00:00:00') : null
    const to   = dateTo   ? new Date(dateTo   + 'T23:59:59') : null

    const q = query ? query.toLowerCase().trim() : ''
    const results = []

    // 扫描所有文件（不限 .md）
    const allFiles = getAllFiles(vaultPath)
    for (const filePath of allFiles) {
      const ext = path.extname(filePath).toLowerCase()
      const fileName = path.basename(filePath)
      const baseName = path.basename(filePath, ext)
      const stat = fs.statSync(filePath)
      const mtime = stat.mtime

      // 文件类型过滤
      if (hasTypeFilter) {
        const isKnown = knownExts.includes(ext)
        if (includeOther && fileTypes.length === 1) {
          if (isKnown) continue // 只看other
        } else if (allowedExts && !allowedExts.has(ext)) {
          if (!includeOther || isKnown) continue
        }
      }

      // 日期过滤
      if (from && mtime < from) continue
      if (to   && mtime > to)   continue

      // 关键词过滤
      let matched = !q
      let snippet = ''
      if (q) {
        if (fileName.toLowerCase().includes(q)) {
          matched = true; snippet = '文件名匹配'
        }
        if (!matched && ext === '.md') {
          try {
            const content = fs.readFileSync(filePath, 'utf-8')
            const idx = content.toLowerCase().indexOf(q)
            if (idx !== -1) {
              matched = true
              const start = Math.max(0, idx - 40)
              const end   = Math.min(content.length, idx + 80)
              snippet = '...' + content.slice(start, end).replace(/\n/g, ' ') + '...'
            }
          } catch (_) {}
        }
      }

      if (matched) {
        results.push({
          name: baseName,
          fullName: fileName,
          path: filePath,
          relativePath: path.relative(vaultPath, filePath),
          ext,
          mtime: mtime.toISOString().slice(0, 10),
          mtimeRaw: mtime.getTime(),
          snippet
        })
      }
    }

    // 排序
    if (sortBy === 'mtime_desc') results.sort((a, b) => b.mtimeRaw - a.mtimeRaw)
    else if (sortBy === 'mtime_asc') results.sort((a, b) => a.mtimeRaw - b.mtimeRaw)
    else if (sortBy === 'name_asc')  results.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    else if (sortBy === 'name_desc') results.sort((a, b) => b.name.localeCompare(a.name, 'zh'))
    // 默认：关键词相关度（文件名匹配优先）
    else if (q) results.sort((a, b) => {
      const aName = a.name.toLowerCase().includes(q) ? 0 : 1
      const bName = b.name.toLowerCase().includes(q) ? 0 : 1
      return aName - bName
    })

    return { success: true, results: results.slice(0, 200), total: results.length }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 在文件管理器中显示 ──
ipcMain.handle('open-file', async (event, filePath) => { shell.showItemInFolder(filePath) })

// ── 在 Obsidian 中打开 ──
ipcMain.handle('open-in-obsidian', async (event, filePath) => {
  shell.openExternal('obsidian://open?path=' + encodeURIComponent(filePath))
  return { success: true }
})

// ── 导入文件 ──
ipcMain.handle('import-files', async (event, { files, targetDir }) => {
  const results = []
  for (const src of files) {
    try {
      const fileName = path.basename(src)
      fs.copyFileSync(src, path.join(targetDir, fileName))
      const mdName = fileName.replace(/\.[^.]+$/, '') + '.md'
      const mdPath = path.join(targetDir, mdName)
      const ext = path.extname(src).replace('.', '').toUpperCase()
      const now = new Date().toISOString().slice(0, 10)
      const mdContent = `---\ntitle: ${fileName}\ndate: ${now}\ntype: ${ext}\nsource: 导入\n---\n\n# ${fileName}\n\n- 导入日期：${now}\n- 文件类型：${ext}\n- 原始文件：[[${fileName}]]\n`
      if (!fs.existsSync(mdPath)) fs.writeFileSync(mdPath, mdContent, 'utf-8')
      results.push({ file: fileName, success: true })
    } catch (err) { results.push({ file: path.basename(src), success: false, error: err.message }) }
  }
  return results
})

// ── 选择要导入的文件 ──
ipcMain.handle('select-import-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], title: '选择要导入的文件' })
  return result.canceled ? [] : result.filePaths
})

// ── 知识库文件夹列表 ──
ipcMain.handle('get-vault-folders', async (event, vaultPath) => {
  try { return { success: true, folders: getFolders(vaultPath, vaultPath) } }
  catch (err) { return { success: false, error: err.message } }
})

// ── 获取平台信息 ──
ipcMain.handle('get-platform', () => process.platform)

// ── 按文件类型列出所有文件 ──
ipcMain.handle('list-files-by-type', async (event, { vaultPath, type }) => {
  try {
    const extMap = {
      md:    ['.md'],
      pdf:   ['.pdf'],
      image: ['.png','.jpg','.jpeg','.gif','.webp'],
      video: ['.mp4','.mov','.avi','.mkv','.webm','.m4v'],
      other: null  // 其他：排除以上所有
    }
    const allExts = ['.md','.pdf','.png','.jpg','.jpeg','.gif','.webp','.mp4','.mov','.avi','.mkv','.webm','.m4v']
    const targetExts = extMap[type]
    const allFiles = []
    function walk(dir) {
      try {
        for (const item of fs.readdirSync(dir)) {
          if (item.startsWith('.')) continue
          const full = path.join(dir, item)
          const stat = fs.statSync(full)
          if (stat.isDirectory()) { walk(full) } else {
            const ext = path.extname(item).toLowerCase()
            const match = type === 'other'
              ? !allExts.includes(ext)
              : targetExts.includes(ext)
            if (match) allFiles.push({
              name: item, path: full,
              relativePath: path.relative(vaultPath, full),
              ext, mtime: stat.mtime.toISOString().slice(0, 10)
            })
          }
        }
      } catch (_) {}
    }
    walk(vaultPath)
    allFiles.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return { success: true, files: allFiles }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 读取指定文件夹内文件（一层）──
ipcMain.handle('list-folder-files', async (event, { folderPath, vaultPath }) => {
  try {
    const items = fs.readdirSync(folderPath)
    const files = [], dirs = []
    for (const item of items) {
      if (item.startsWith('.')) continue
      const full = path.join(folderPath, item)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        dirs.push({ name: item, path: full, isDir: true })
      } else {
        files.push({ name: item, path: full, relativePath: path.relative(vaultPath, full), ext: path.extname(item).toLowerCase(), mtime: stat.mtime.toISOString().slice(0, 10), isDir: false })
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return { success: true, items: [...dirs, ...files] }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 待处理文件库 ──
ipcMain.handle('select-inbox', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择待处理文件夹' })
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('inboxPath', result.filePaths[0])
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})
ipcMain.handle('get-inbox-path', () => store.get('inboxPath', null))

// ── 列出待处理文件库文件 ──
ipcMain.handle('list-inbox-files', async (event, inboxPath) => {
  try {
    const files = []
    for (const item of fs.readdirSync(inboxPath)) {
      if (item.startsWith('.')) continue
      const full = path.join(inboxPath, item)
      const stat = fs.statSync(full)
      if (stat.isFile()) files.push({ name: item, path: full, size: stat.size, mtime: stat.mtime.toISOString().slice(0, 10), ext: path.extname(item).toLowerCase() })
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return { success: true, files }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 重复文件检测（按文件名+大小判断）──
ipcMain.handle('check-duplicate-files', async (event, vaultPath) => {
  try {
    const allFiles = getAllFiles(vaultPath)
    const map = {}
    for (const fp of allFiles) {
      try {
        const stat = fs.statSync(fp)
        const name = path.basename(fp).toLowerCase()
        const key = name + '|' + stat.size
        if (!map[key]) map[key] = []
        map[key].push({ name: path.basename(fp), path: fp, relativePath: path.relative(vaultPath, fp), size: stat.size, mtime: stat.mtime.toISOString().slice(0,10) })
      } catch (_) {}
    }
    const duplicates = Object.values(map).filter(g => g.length > 1)
    return { success: true, duplicates }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 空文件检测（内容为空或只有 frontmatter 的 md 文件）──
ipcMain.handle('check-empty-files', async (event, vaultPath) => {
  try {
    const allFiles = getAllFiles(vaultPath)
    const empty = []
    for (const fp of allFiles) {
      try {
        const stat = fs.statSync(fp)
        const ext = path.extname(fp).toLowerCase()
        let isEmpty = false
        if (stat.size === 0) {
          isEmpty = true
        } else if (ext === '.md') {
          const content = fs.readFileSync(fp, 'utf-8').trim()
          // 去掉 frontmatter 后看正文是否为空
          const withoutFm = content.replace(/^---[\s\S]*?---\n?/, '').trim()
          // 去掉标题行后看是否还有实质内容
          const withoutTitle = withoutFm.replace(/^#[^\n]*\n?/, '').trim()
          if (withoutTitle.length === 0) isEmpty = true
        }
        if (isEmpty) {
          empty.push({
            name: path.basename(fp),
            path: fp,
            relativePath: path.relative(vaultPath, fp),
            size: stat.size,
            mtime: stat.mtime.toISOString().slice(0, 10),
            ext
          })
        }
      } catch (_) {}
    }
    return { success: true, empty }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 删除文件（移到系统回收站）──
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    shell.trashItem(filePath)
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 标签统计（只读 frontmatter，不扫正文）──
ipcMain.handle('get-tag-stats', async (event, vaultPath) => {
  try {
    const allMdFiles = getAllFiles(vaultPath, '.md')
    const tagCount = {}
    for (const filePath of allMdFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const fmMatch = content.match(/^---[\s\S]*?^---/m)
        if (!fmMatch) continue
        const fm = fmMatch[0]
        // tags: [a, b, c] 格式
        const tagLine = fm.match(/tags:\s*\[([^\]]+)\]/)
        if (tagLine) {
          tagLine[1].split(',').forEach(t => {
            const tag = t.trim().replace(/['"]/g, '')
            if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1
          })
        }
        // tags: 列表格式
        const tagLines = fm.match(/tags:([\s\S]*?)(?=\n\w|\n---)/m)
        if (tagLines) {
          ;(tagLines[1].match(/- .+/g) || []).forEach(t => {
            const tag = t.replace('- ', '').trim()
            if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1
          })
        }
      } catch (_) {}
    }
    return { success: true, tags: Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).map(([tag,count])=>({tag,count})) }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 按标签查找笔记（只读 frontmatter）──
ipcMain.handle('search-by-tag', async (event, { vaultPath, tag }) => {
  try {
    const allMdFiles = getAllFiles(vaultPath, '.md')
    const results = [], tagLower = tag.toLowerCase()
    for (const filePath of allMdFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const fmMatch = content.match(/^---[\s\S]*?^---/m)
        if (!fmMatch) continue
        const fm = fmMatch[0]
        let matched = false
        const tagLine = fm.match(/tags:\s*\[([^\]]+)\]/)
        if (tagLine && tagLine[1].split(',').map(t=>t.trim().replace(/['"]/g,'').toLowerCase()).includes(tagLower)) matched = true
        if (!matched) {
          const tagLines = fm.match(/tags:([\s\S]*?)(?=\n\w|\n---)/m)
          if (tagLines && (tagLines[1].match(/- .+/g)||[]).map(t=>t.replace('- ','').trim().toLowerCase()).includes(tagLower)) matched = true
        }
        if (matched) results.push({ name: path.basename(filePath,'.md'), path: filePath, relativePath: path.relative(vaultPath, filePath) })
      } catch (_) {}
    }
    return { success: true, results }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 移动笔记 ──
ipcMain.handle('move-note', async (event, { srcPath, targetDir }) => {
  try {
    const fileName = path.basename(srcPath)
    const destPath = path.join(targetDir, fileName)
    if (fs.existsSync(destPath)) return { success: false, error: '目标位置已存在同名文件' }
    fs.renameSync(srcPath, destPath)
    return { success: true, path: destPath }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 新建笔记 ──
ipcMain.handle('create-note', async (event, { vaultPath, targetDir, title, template, body }) => {
  try {
    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    const time = now.toTimeString().slice(0, 5)
    const safeTitle = title || now.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
    const bodyText = body ? '\n' + body + '\n' : '\n'
    let content = ''
    if (template === 'daily') {
      content = `---\ndate: ${date}\ntype: 今日备忘\ntags: [今日备忘]\n---\n\n# ${date} 今日备忘\n\n## ✅ 今日待办\n${bodyText}\n## 📝 今日记录\n\n\n## 📌 明日计划\n\n`
    } else if (template === 'book') {
      content = `---\ndate: ${date}\ntype: 读书笔记\ntags: [读书笔记]\ntitle: ${safeTitle}\n---\n\n# 《${safeTitle}》读书笔记\n\n## 基本信息\n- 作者：\n- 阅读日期：${date}\n\n## 核心观点\n\n\n## 摘录\n${bodyText}\n## 读后感\n\n`
    } else if (template === 'meeting') {
      // 会议记录：有标题用标题，没有标题用"会议记录 日期"
      const meetingTitle = title ? title : `会议记录 ${date}`
      const safeM = meetingTitle
      content = `---\ndate: ${date}\ntype: 会议记录\ntags: [会议记录]\ntitle: ${safeM}\n---\n\n# ${safeM}\n\n## 参与人员\n\n\n## 会议议题\n\n\n## 讨论内容\n${bodyText}\n## 待办事项\n\n`
    } else {
      content = `---\ndate: ${date}\ntags: []\ntitle: ${safeTitle}\n---\n\n# ${safeTitle}\n${bodyText}`
    }
    // 会议记录文件名也用会议标题
    const fileName = template === 'daily'
      ? `${date}.md`
      : template === 'meeting' && title
        ? `${title}.md`
        : template === 'meeting'
          ? `会议记录 ${date}.md`
          : `${safeTitle}.md`
    const filePath = path.join(targetDir || vaultPath, fileName)
    if (fs.existsSync(filePath)) return { success: false, error: '同名文件已存在' }
    fs.writeFileSync(filePath, content, 'utf-8')
    return { success: true, path: filePath }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 工具函数 ──
function getAllFiles(dir, ext) {
  let results = []
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      const full = path.join(dir, item)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) results = results.concat(getAllFiles(full, ext))
      else if (!ext || full.endsWith(ext)) results.push(full)
    }
  } catch (_) {}
  return results
}

function getFolders(dir, rootPath) {
  let results = [{ label: '（根目录）', value: rootPath }]
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      const full = path.join(dir, item)
      if (fs.statSync(full).isDirectory()) {
        results.push({ label: path.relative(rootPath, full), value: full })
        results = results.concat(getFolders(full, rootPath).slice(1))
      }
    }
  } catch (_) {}
  return results
}

function scanDirectory(dir) {
  let mdCount = 0, pdfCount = 0, imgCount = 0, videoCount = 0, otherCount = 0
  const recentFiles = []
  function walk(d) {
    try {
      for (const item of fs.readdirSync(d)) {
        if (item.startsWith('.')) continue
        const full = path.join(d, item)
        const stat = fs.statSync(full)
        if (stat.isDirectory()) { walk(full) } else {
          const ext = path.extname(item).toLowerCase()
          if (ext === '.md') mdCount++
          else if (ext === '.pdf') pdfCount++
          else if (['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)) imgCount++
          else if (['.mp4','.mov','.avi','.mkv','.webm','.m4v'].includes(ext)) videoCount++
          else otherCount++
          recentFiles.push({ name: item, path: full, mtime: stat.mtime })
        }
      }
    } catch (_) {}
  }
  walk(dir)
  recentFiles.sort((a, b) => b.mtime - a.mtime)
  const recent = recentFiles.slice(0, 10).map(f => ({ name: f.name, path: f.path, relativePath: path.relative(dir, f.path), mtime: f.mtime.toISOString().slice(0, 10) }))
  return { mdCount, pdfCount, imgCount, videoCount, otherCount, recent, folderTree: buildTree(dir) }
}

function buildTree(dir, depth) {
  depth = depth || 0
  const name = depth === 0 ? path.basename(dir) + ' （根目录）' : path.basename(dir)
  const node = { name, path: dir, children: [] }
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      const full = path.join(dir, item)
      if (fs.statSync(full).isDirectory()) node.children.push(buildTree(full, depth + 1))
    }
  } catch (_) {}
  return node
}
