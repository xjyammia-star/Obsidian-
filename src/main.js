const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const Store = require('electron-store')

const store = new Store()
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 600,
    title: 'Obsidian 管理工具',
    icon: path.join(__dirname, '../assets/icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    acceptFirstMouse: true
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // 主进程监听渲染进程的 drop 事件，获取文件路径
}

app.whenReady().then(() => {
  createWindow()
  if (process.platform === 'darwin') {
    try {
      const { nativeImage } = require('electron')
      const icnsPath = path.join(__dirname, '../assets/icon.icns')
      if (fs.existsSync(icnsPath)) {
        const image = nativeImage.createFromPath(icnsPath)
        if (!image.isEmpty()) app.dock.setIcon(image)
      }
    } catch (e) { console.log('dock icon error:', e.message) }
  }
})
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
  console.log('[IPC] get-vault-stats called at', Date.now())
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
      // 移到已处理文件夹
      const inboxDir = path.dirname(src)
      const processedDir = path.join(inboxDir, '已处理')
      if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir)
      const processedPath = path.join(processedDir, fileName)
      try {
        if (fs.existsSync(processedPath)) {
          const ts = Date.now(), ext2 = path.extname(fileName), base = path.basename(fileName, ext2)
          fs.renameSync(src, path.join(processedDir, `${base}_${ts}${ext2}`))
        } else {
          fs.renameSync(src, processedPath)
        }
      } catch (_) {}
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


// -- get-folder-tree: folder tree with depth for AI analysis --
ipcMain.handle('get-folder-tree', async (event, vaultPath) => {
  try { return { success: true, tree: buildAnalyzeTree(vaultPath, vaultPath, 0) } }
  catch (err) { return { success: false, error: err.message } }
})

// -- get-folder-md-files: md files in a folder (non-recursive) --
ipcMain.handle('get-folder-md-files', async (event, folderPath) => {
  try {
    const files = []
    for (const item of fs.readdirSync(folderPath)) {
      if (item.startsWith('.')) continue
      const full = path.join(folderPath, item)
      const stat = fs.lstatSync(full)
      if (!stat.isDirectory() && path.extname(item).toLowerCase() === '.md') {
        files.push({ name: item, path: full, mtime: stat.mtime.toISOString().slice(0,10) })
      }
      // 显示 iCloud 占位符中的 .md 文件（未下载）
      if (item.endsWith('.icloud') && item.includes('.md')) {
        const realName = item.replace(/^\./, '').replace(/\.icloud$/, '')
        files.push({ name: realName, path: full, mtime: '', cloud: true })
      }
    }
    return { success: true, files }
  } catch (err) { return { success: false, error: err.message } }
})
// ── 获取平台信息 ──
ipcMain.handle('get-platform', () => process.platform)

// -- drop 中转：preload 发来文件路径，主进程原样发回渲染进程 --
ipcMain.on('renderer-files-dropped', (event, paths) => {
  event.sender.send('files-dropped-reply', paths)
})

// -- resolve-dropped-files: 用文件元信息在磁盘上搜索完整路径 --
ipcMain.handle('resolve-dropped-files', async (event, fileInfos) => {
  // webUtils 在 preload 环境不可用，改为在常用目录里搜索同名文件
  const os = require('os')
  const home = os.homedir()
  const vaultPath = store.get('vaultPath', null)
  const inboxPath = store.get('inboxPath', null)
  // 不搜索 vaultPath（可能在 iCloud），只搜索本地常用目录
  const searchDirs = [
    inboxPath,
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
  ].filter(Boolean)
  const results = []
  for (const info of fileInfos) {
    let found = null
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue
      try {
        const walk = (d, depth) => {
          if (depth > 3) return
          for (const item of fs.readdirSync(d)) {
            if (item.startsWith('.')) continue
            const full = path.join(d, item)
            try {
              const stat = fs.statSync(full)
              if (stat.isDirectory()) { walk(full, depth + 1) }
              else if (item === info.name && Math.abs(stat.size - info.size) < 100) {
                found = full
                throw 'found'
              }
            } catch(e) { if (e === 'found') throw e }
          }
        }
        try { walk(dir, 0) } catch(e) { if (e === 'found') break }
      } catch(_) {}
      if (found) break
    }
    if (found) results.push(found)
  }
  return results
})

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

// ── 获取已处理文件夹信息 ──
ipcMain.handle('get-processed-folder', async (event, inboxPath) => {
  try {
    const processedDir = path.join(inboxPath, '已处理')
    if (!fs.existsSync(processedDir)) return { success: true, count: 0, size: 0 }
    const files = fs.readdirSync(processedDir).filter(f => !f.startsWith('.'))
    let size = 0
    files.forEach(f => { try { size += fs.statSync(path.join(processedDir, f)).size } catch (_) {} })
    return { success: true, count: files.length, size, path: processedDir }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 清除已处理文件夹 ──
ipcMain.handle('clear-processed-folder', async (event, inboxPath) => {
  try {
    const processedDir = path.join(inboxPath, '已处理')
    if (!fs.existsSync(processedDir)) return { success: true, count: 0 }
    const files = fs.readdirSync(processedDir).filter(f => !f.startsWith('.'))
    let count = 0
    for (const f of files) {
      try {
        await shell.trashItem(path.join(processedDir, f))
        count++
      } catch (_) {
        try { fs.unlinkSync(path.join(processedDir, f)); count++ } catch (_) {}
      }
    }
    return { success: true, count }
  } catch (err) { return { success: false, error: err.message } }
})
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
    await shell.trashItem(filePath)
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 移动文件到指定文件夹 ──
ipcMain.handle('move-file', async (event, { srcPath, destDir }) => {
  try {
    const fileName = path.basename(srcPath)
    let destPath = path.join(destDir, fileName)
    // 目标已存在时加时间戳后缀避免覆盖
    if (fs.existsSync(destPath)) {
      const ext = path.extname(fileName)
      const base = path.basename(fileName, ext)
      const ts = Date.now()
      destPath = path.join(destDir, `${base}_${ts}${ext}`)
    }
    fs.renameSync(srcPath, destPath)
    return { success: true, destPath }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 扫描缺少标签的笔记 ──
ipcMain.handle('scan-missing-summary', async (event, { scanPath, vaultPath }) => {
  try {
    const files = []
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir)) {
        if (item.startsWith('.') || item.endsWith('.icloud')) continue
        const full = path.join(dir, item)
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) { walk(full); continue }
        if (!item.endsWith('.md')) continue
        const content = fs.readFileSync(full, 'utf-8')
        // 检查是否有 tags 字段且不为空
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (fmMatch) {
          const fm = fmMatch[1]
          const tagsMatch = fm.match(/^tags\s*:/m)
          if (tagsMatch) {
            // 有 tags 字段，检查是否有实际内容（不是空数组 []）
            const tagsLine = fm.match(/^tags\s*:\s*(.+)$/m)
            if (tagsLine && tagsLine[1].trim() !== '[]' && tagsLine[1].trim() !== '') continue
            // 检查多行格式
            const tagsBlock = fm.match(/^tags\s*:\s*\n((?:\s+-\s*.+\n?)+)/m)
            if (tagsBlock) continue
          }
        }
        // 文件内容太少（少于50字）跳过
        const body = content.replace(/^---[\s\S]*?---\r?\n?/, '').trim()
        if (body.length < 50) continue
        files.push({
          name: item,
          path: full,
          relativePath: path.relative(vaultPath, full)
        })
      }
    }
    walk(scanPath)
    return { success: true, files }
  } catch (err) { return { success: false, error: err.message } }
})

// ── 为单篇笔记写入 AI 标签 ──
ipcMain.handle('write-summary', async (event, { filePath }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先配置 API Key' }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const body = raw.replace(/^---[\s\S]*?---\r?\n?/, '').trim().slice(0, 2000)
    if (!body) return { success: false, error: '文件内容为空' }

    const fileName = path.basename(filePath, '.md')
    const folderName = path.dirname(filePath).split(path.sep).pop()
    const prompt = `你是知识库标签助手。请根据以下笔记内容，推断1到3个合适的中文标签（参考文件夹名称判断领域）。
只输出标签，用英文逗号分隔，不要加[]或引号，不要解释。

文件名：${fileName}
所在文件夹：${folderName}
内容摘录：
${body}`

    const reply = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: prompt }], 100
    )
    const tagsStr = reply.trim().replace(/[\[\]"']/g, '').trim()
    if (!tagsStr) return { success: false, error: 'AI 返回空内容' }
    const tags = tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean)
    if (!tags.length) return { success: false, error: '未能解析出标签' }

    const tagsYaml = '[' + tags.map(t => t).join(', ') + ']'

    // 写入 frontmatter
    let newContent
    if (raw.match(/^---\r?\n/)) {
      newContent = raw.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/,
        (_, open, fm, close) => {
          const cleaned = fm.replace(/^tags\s*:.*$/m, '').replace(/\n+$/, '')
          return `${open}${cleaned}\ntags: ${tagsYaml}${close}`
        }
      )
    } else {
      newContent = `---\ntags: ${tagsYaml}\n---\n\n${raw}`
    }
    fs.writeFileSync(filePath, newContent, 'utf-8')
    return { success: true, tags }
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

// ── 设置：保存/读取 AI 配置 ──
ipcMain.handle('save-ai-settings', async (event, settings) => {
  store.set('aiSettings', settings)
  return { success: true }
})
ipcMain.handle('get-ai-settings', () => {
  return store.get('aiSettings', {
    apiKey: '',
    modelId: '',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    audioModelId: '',
    aiClassifyEnabled: false,
    reminderEnabled: false,
    reminderAdvance: 0,
    inboxFolder: '',
    ytCookiesFile: '',
    hubCustomEnabled: false,
    hubFilenames: ''
  })
})

// ── 设置：选择临时文件夹 ──
ipcMain.handle('select-inbox-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: '选择临时文件夹（无法分类的文件存放位置）'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})

// ── AI 调用（火山引擎）──
function callVolcanoAI(apiKey, modelId, endpoint, messages, maxTokens) {
  const timeoutMs = 60000
  const apiCall = new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: modelId, messages, max_tokens: maxTokens || 500 })
    const url = new URL(endpoint + '/chat/completions')
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json.choices?.[0]?.message?.content || '')
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI 请求超时（20秒）')), timeoutMs)
  )
  return Promise.race([apiCall, timeout])
}

// ── AI 分类单个文件 ──
ipcMain.handle('ai-classify-file', async (event, { filePath, vaultPath, vaultFolders }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) return { success: false, error: '未设置 API Key 或模型ID' }

  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const isText = ['.md', '.txt'].includes(ext)
  const isPdf = ext === '.pdf'

  let contentForAI = `文件名：${fileName}`

  // md/txt 读取正文
  if (isText) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 1500)
      contentForAI += `\n正文内容（前1500字）：\n${body}`
    } catch (_) {}
  }

  // PDF 提取文字（只处理文字版，加超时保护）
  if (isPdf) {
    try {
      const { execSync } = require('child_process')
      const text = execSync(`pdftotext "${filePath}" - 2>/dev/null`, { timeout: 5000 }).toString().slice(0, 1500)
      if (text.trim()) contentForAI += `\nPDF内容（前1500字）：\n${text}`
    } catch (_) {
      // pdftotext 不存在或超时，只用文件名判断
    }
  }

  // 构建知识库文件夹列表
  const folderList = vaultFolders.map(f => f.label).filter(l => l !== '（根目录）').join('、')

  const prompt = `你是一个知识库文件分类助手。
知识库现有文件夹：${folderList}
请根据以下文件信息，判断：
1. 最适合存放的文件夹路径（从上面的列表中选择，输出相对路径，如"01 AI/Claude"）
2. 适合的标签（可自由生成，用逗号分隔，中文）
3. 如果是md文件且没有标题，建议一个标题（不超过20字）

文件信息：
${contentForAI}

请严格按以下JSON格式回复，不要加任何其他文字：
{"folder":"xxx","tags":"xxx,xxx","title":"xxx"}`

  try {
    const reply = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [
      { role: 'user', content: prompt }
    ])
    const clean = reply.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)
    return { success: true, folder: result.folder, tags: result.tags, title: result.title }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── 导入并 AI 分类（批量，并行处理）──
ipcMain.handle('ai-import-files', async (event, { files, vaultPath, vaultFolders }) => {
  const settings = store.get('aiSettings', {})
  const inboxFolder = settings.inboxFolder || path.join(vaultPath, '00 Inbox')

  // 并行处理所有文件
  const results = await Promise.all(files.map(async srcPath => {
    try {
      const ext = path.extname(srcPath).toLowerCase()
      const fileName = path.basename(srcPath)
      const isText = ['.md', '.txt'].includes(ext)

      // 检查是否为空文件，空文件直接存 inbox 不调 AI
      let isEmpty = false
      if (isText) {
        try {
          const raw = fs.readFileSync(srcPath, 'utf-8').trim()
          const body = raw.replace(/^---[\s\S]*?---\n?/, '').replace(/^#[^\n]*\n?/, '').trim()
          if (body.length < 10) isEmpty = true
        } catch (_) {}
      }

      let targetDir = inboxFolder
      let aiFolder = isEmpty ? '00 Inbox（内容为空）' : ''
      let aiTags = ''
      let aiTitle = ''

      if (!isEmpty) {
        // 调 AI 分类
        const classify = await (async () => {
          try {
            // 复用 ai-classify-file 的逻辑
            if (!settings.apiKey || !settings.modelId) return null
            let contentForAI = `文件名：${fileName}`
            if (isText) {
              const raw = fs.readFileSync(srcPath, 'utf-8')
              const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 1500)
              contentForAI += `\n正文内容：\n${body}`
            } else if (ext === '.pdf') {
              try {
                const { execSync } = require('child_process')
                const text = execSync(`pdftotext "${srcPath}" - 2>/dev/null`, { timeout: 5000 }).toString().slice(0, 1500)
                if (text.trim()) contentForAI += `\nPDF内容：\n${text}`
              } catch (_) {}
            }
            const folderList = vaultFolders.map(f => f.label).filter(l => l !== '（根目录）').join('、')
            const prompt = `你是知识库分类助手。知识库文件夹：${folderList}\n根据以下文件信息判断：1.存放文件夹（输出相对路径如"01 AI/Claude"）2.标签（中文逗号分隔）3.md文件无标题则建议标题（20字内）\n文件信息：${contentForAI}\n只输出JSON：{"folder":"xxx","tags":"xxx","title":"xxx"}`
            const reply = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: prompt }])
            const clean = reply.replace(/```json|```/g, '').trim()
            return JSON.parse(clean)
          } catch (_) { return null }
        })()

        if (classify && classify.folder) {
          const matched = vaultFolders.find(f => f.label === classify.folder || f.value.endsWith(classify.folder))
          if (matched) { targetDir = matched.value; aiFolder = classify.folder }
          else aiFolder = '00 Inbox（路径未匹配）'
          aiTags = classify.tags || ''
          aiTitle = classify.title || ''
        } else {
          aiFolder = '00 Inbox（AI无法判断）'
        }
      }

      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
      const destPath = path.join(targetDir, fileName)
      fs.copyFileSync(srcPath, destPath)

      // 把源文件移到待处理文件库的「已处理」文件夹
      const inboxDir = path.dirname(srcPath)
      const processedDir = path.join(inboxDir, '已处理')
      if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir)
      const processedPath = path.join(processedDir, fileName)
      try {
        if (fs.existsSync(processedPath)) {
          // 同名文件加时间戳避免冲突
          const ts = Date.now()
          const ext2 = path.extname(fileName)
          const base = path.basename(fileName, ext2)
          fs.renameSync(srcPath, path.join(processedDir, `${base}_${ts}${ext2}`))
        } else {
          fs.renameSync(srcPath, processedPath)
        }
      } catch (_) {}

      // 更新 md 文件 frontmatter
      if (ext === '.md' && (aiTags || aiTitle)) {
        let content = fs.readFileSync(destPath, 'utf-8')
        const date = new Date().toISOString().slice(0, 10)
        const tagsArr = aiTags ? aiTags.split(',').map(t => t.trim()).filter(Boolean) : []
        const tagsYaml = tagsArr.length ? `[${tagsArr.join(', ')}]` : '[]'
        if (content.startsWith('---')) {
          if (aiTags && !content.match(/^tags:/m)) {
            content = content.replace(/^---/, `---\ntags: ${tagsYaml}`)
          }
        } else {
          const title = aiTitle || path.basename(srcPath, '.md')
          content = `---\ntitle: ${title}\ndate: ${date}\ntags: ${tagsYaml}\n---\n\n${content}`
        }
        fs.writeFileSync(destPath, content, 'utf-8')
      }

      return { file: fileName, success: true, targetDir, aiFolder, aiTags, aiTitle, isEmpty }
    } catch (err) {
      return { file: path.basename(srcPath), success: false, error: err.message }
    }
  }))

  return results
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
      if (item.endsWith('.icloud')) continue // 跳过 iCloud 占位符文件
      const full = path.join(dir, item)
      const stat = fs.lstatSync(full) // lstat 不触发 iCloud 下载
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
      if (item.endsWith('.icloud')) continue
      const full = path.join(dir, item)
      if (fs.lstatSync(full).isDirectory()) {
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
        if (item.endsWith('.icloud')) continue
        const full = path.join(d, item)
        const stat = fs.lstatSync(full)
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
      if (item.endsWith('.icloud')) continue
      const full = path.join(dir, item)
      if (fs.lstatSync(full).isDirectory()) node.children.push(buildTree(full, depth + 1))
    }
  } catch (_) {}
  return node
}

// ── AI 分析文件夹（Map-Reduce：逐篇提取摘要 → 汇总生成报告）──
ipcMain.handle('ai-analyze-folder', async (event, { filePaths, userPrompt }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }
  const mdFiles = (filePaths || []).filter(p => p.endsWith('.md'))
  if (!mdFiles.length) { return { success: false, error: '没有选择任何 Markdown 文件' } }
  const summaries = []
  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i]
    const fileName = path.basename(filePath, '.md')
    event.sender.send('ai-analyze-progress', { current: i + 1, total: mdFiles.length, fileName })
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 2000)
      if (!body) { summaries.push({ fileName, title: fileName, summary: '（文件内容为空）', keywords: [], keyPoints: [] }); continue }
      const mapPrompt = '请阅读以下笔记，提取关键信息，只输出 JSON，不要加任何其他文字：\n{"title":"笔记标题或核心主题（15字内）","keywords":["关键词1","关键词2"],"summary":"核心内容一句话概括（60字内）","keyPoints":["要点1","要点2"]}\n\n笔记文件名：' + fileName + '\n笔记内容：\n' + body
      const reply = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: mapPrompt }])
      const clean = reply.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      summaries.push({ fileName, title: parsed.title || fileName, keywords: parsed.keywords || [], summary: parsed.summary || '', keyPoints: parsed.keyPoints || [] })
    } catch (err) { summaries.push({ fileName, title: fileName, summary: '（解析失败）', keywords: [], keyPoints: [] }) }
  }
  event.sender.send('ai-analyze-progress', { current: mdFiles.length, total: mdFiles.length, fileName: '正在生成报告...', reducing: true })
  const summaryText = summaries.map((s, i) =>
    '【' + (i+1) + '】' + (s.title || s.fileName) + '\n关键词：' + ((s.keywords || []).join('、') || '无') + '\n摘要：' + s.summary + '\n要点：' + ((s.keyPoints || []).join('；') || '无')
  ).join('\n\n')
  const reducePrompt = '你是一个知识管理助手。以下是用户选择的 ' + summaries.length + ' 篇笔记的摘要信息。\n\n' + summaryText + '\n\n---\n用户需求：' + userPrompt + '\n\n请根据用户需求，基于以上所有笔记内容，生成相应的输出。用中文回答，使用 Markdown 格式。'
  try {
    const finalReply = await callVolcanoAI(settings.apiKey, settings.modelId, settings.endpoint, [{ role: 'user', content: reducePrompt }], 4000)
    return { success: true, result: finalReply, fileCount: mdFiles.length }
  } catch (err) { return { success: false, error: '生成报告失败：' + err.message } }
})

// ── AI 音频/视频转笔记 ──
ipcMain.handle('select-audio-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: '选择音频或视频文件',
    filters: [
      { name: '音频/视频文件', extensions: ['mp3','mp4','m4a','wav','ogg','mov','avi','mkv','aac','flac','wma','webm'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (!result.canceled && result.filePaths.length > 0) {
    const fp = result.filePaths[0]
    const stat = fs.statSync(fp)
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
    return { success: true, path: fp, name: path.basename(fp), sizeMB }
  }
  return { success: false }
})

ipcMain.handle('ai-audio-to-note', async (event, { filePath, customPrompt }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey) return { success: false, error: '请先在系统设置中配置 API Key' }
  const audioModelId = settings.audioModelId || ''
  if (!audioModelId) return { success: false, error: '请先在系统设置中配置「音频/视频模型 ID」（如 doubao-seed-2.0-lite 的接入点 ID）' }

  const endpoint = settings.endpoint || 'https://ark.cn-beijing.volces.com/api/v3'

  try {
    // Step 1: 上传文件到 Files API
    event.sender.send('audio-note-progress', { step: 'upload', msg: '正在上传文件（可能需要几十秒）...' })
    const fileId = await uploadFileToArk(settings.apiKey, endpoint, filePath)

    // Step 1.5: 等待文件处理完毕（status 变为 active）
    event.sender.send('audio-note-progress', { step: 'upload', msg: '文件上传成功，等待处理完毕...' })
    await waitFileActive(settings.apiKey, endpoint, fileId)

    // Step 2: 调用多模态模型转录+理解
    event.sender.send('audio-note-progress', { step: 'transcribe', msg: '正在识别语音内容...' })
    const fileName = path.basename(filePath)
    const transcribePrompt = '请完整转录这个音频/视频文件中的所有语音内容，输出完整的转录文本，不要遗漏任何内容，保持自然段落分隔。只输出转录文本，不要加任何说明。'
    const transcriptRaw = await callArkMultimodal(settings.apiKey, audioModelId, endpoint, fileId, transcribePrompt, filePath)

    // 如果是空或者错误信息，直接返回原始内容方便调试
    if (!transcriptRaw) {
      return { success: false, error: '模型返回了空响应，请确认音频模型ID是否正确，文件是否有语音内容' }
    }
    const transcript = transcriptRaw.trim()
    if (transcript.length < 5) {
      return { success: false, error: '转录结果过短（' + transcript.length + '字），原始响应：' + JSON.stringify(transcriptRaw) }
    }

    // Step 3: 用 DeepSeek 整理成结构化笔记
    event.sender.send('audio-note-progress', { step: 'organize', msg: '正在生成结构化笔记...' })
    const noteModelId = settings.modelId || audioModelId
    const noteEndpoint = endpoint
    const basePrompt = customPrompt && customPrompt.trim()
      ? customPrompt.trim()
      : '请整理成结构化笔记，包含：核心主题、主要内容摘要、关键要点列表。'
    const organizePrompt = '以下是一段音频/视频（文件名：' + fileName + '）的完整转录内容：\n\n' + transcript + '\n\n请根据以下要求生成笔记：\n' + basePrompt + '\n\n请用 Markdown 格式输出，笔记结构如下：\n1. 上半部分：AI 整理的结构化笔记（标题、摘要、关键要点）\n2. 下半部分：用 --- 分隔，标题为「原始转录文本」，附上完整转录内容。'
    const organizedNote = await callVolcanoAI(settings.apiKey, noteModelId, noteEndpoint, [{ role: 'user', content: organizePrompt }], 4000)

    event.sender.send('audio-note-progress', { step: 'done', msg: '完成！' })
    return { success: true, result: organizedNote, transcript, fileName }
  } catch (err) {
    return { success: false, error: '处理失败：' + err.message }
  }
})

// 等待文件状态变为 active（上传后服务端需要处理）
function waitFileActive(apiKey, endpoint, fileId) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const maxAttempts = 30  // 最多等 60 秒
    function check() {
      attempts++
      if (attempts > maxAttempts) { reject(new Error('文件处理超时，请重试')); return }
      const url = new URL(endpoint + '/files/' + fileId)
      const options = {
        hostname: url.hostname, path: url.pathname, method: 'GET',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      }
      const req = https.request(options, res => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.status === 'active') { resolve(); return }
            if (json.status === 'error') { reject(new Error('文件处理失败：' + JSON.stringify(json))); return }
            // 还在处理中，等 2 秒再试
            setTimeout(check, 2000)
          } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.end()
    }
    // 先等 1 秒再开始轮询
    setTimeout(check, 1000)
  })
}

// 上传文件到火山方舟 Files API，返回 file_id
function uploadFileToArk(apiKey, endpoint, filePath) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath)
    const fileName = path.basename(filePath)
    const boundary = '----ArkBoundary' + Date.now().toString(16)
    const CRLF = '\r\n'
    // 正确的 multipart 结构：purpose 字段 + file 字段
    const part1 = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="purpose"' + CRLF + CRLF +
      'user_data' + CRLF
    )
    const part2Header = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="' + fileName + '"' + CRLF +
      'Content-Type: application/octet-stream' + CRLF + CRLF
    )
    const part2Footer = Buffer.from(CRLF + '--' + boundary + '--' + CRLF)
    const fullBody = Buffer.concat([part1, part2Header, fileBuffer, part2Footer])
    const url = new URL(endpoint + '/files')
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': fullBody.length
      }
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.id) resolve(json.id)
          else reject(new Error('上传失败：' + JSON.stringify(json)))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(fullBody)
    req.end()
  })
}

// 调用多模态模型（doubao-seed）处理音频/视频文件
// 官方文档：音频用 input_audio + file_id，视频用 video_url + file_id
function callArkMultimodal(apiKey, modelId, endpoint, fileId, prompt, filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1)
  const videoExts = ['mp4','mov','avi','mkv','webm']
  const isVideo = videoExts.includes(ext)

  return new Promise((resolve, reject) => {
    let mediaContent
    if (isVideo) {
      mediaContent = { type: 'video_url', video_url: { file_id: fileId } }
    } else {
      mediaContent = { type: 'input_audio', input_audio: { file_id: fileId } }
    }
    const messages = [{
      role: 'user',
      content: [
        mediaContent,
        { type: 'text', text: prompt }
      ]
    }]
    const body = JSON.stringify({ model: modelId, messages, max_tokens: 8000 })
    const url = new URL(endpoint + '/chat/completions')
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = require('https').request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.error) { reject(new Error('API错误: ' + JSON.stringify(json.error))); return }
          const content = json.choices?.[0]?.message?.content
          resolve(content !== undefined ? content : null)
        } catch (e) { reject(new Error('解析响应失败: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function buildAnalyzeTree(dir, rootPath, depth) {
  depth = depth || 0
  const name = depth === 0 ? path.basename(dir) + '（根目录）' : path.basename(dir)
  const node = { name, path: dir, depth, children: [] }
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.startsWith('.')) continue
      if (item.endsWith('.icloud')) continue
      const full = path.join(dir, item)
      if (fs.lstatSync(full).isDirectory()) node.children.push(buildAnalyzeTree(full, rootPath, depth + 1))
    }
  } catch (_) {}
  return node
}

// ── 选择 YouTube Cookies 文件 ──
ipcMain.handle('select-cookies-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 YouTube Cookies 文件',
    filters: [{ name: 'Cookies 文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
    properties: ['openFile']
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] }
  }
  return { success: false }
})

// ── YouTube 字幕抓取（基于 yt-dlp）──
const { execFile, execSync } = require('child_process')
const os = require('os')
const isWin = process.platform === 'win32'

function getYtDlpPath() {
  // 优先用项目目录下的 yt-dlp（Windows 用 .exe，Mac/Linux 不带后缀）
  const localName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
  const localPath = path.join(__dirname, '..', localName)
  if (fs.existsSync(localPath)) return localPath
  // 再找系统 PATH
  try {
    const whichCmd = isWin ? 'where yt-dlp' : 'which yt-dlp'
    const found = execSync(whichCmd, { timeout: 3000 }).toString().trim().split('\n')[0].trim()
    if (found) return found
  } catch (_) {}
  return null
}

async function ensureYtDlp(sendProgress) {
  const existing = getYtDlpPath()
  if (existing) return existing

  // 自动下载 yt-dlp 到项目目录（按平台选择文件）
  sendProgress('首次使用：正在自动安装 yt-dlp（约 10MB，只需一次）...')
  const ytDlpFileName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
  const destPath = path.join(__dirname, '..', ytDlpFileName)
  const ytDlpDownloadUrl = isWin
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
  return new Promise((resolve, reject) => {
    const https = require('https')
    const url = ytDlpDownloadUrl
    const followRedirect = (urlStr) => {
      const u = new URL(urlStr)
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirect(res.headers.location); return
        }
        const file = fs.createWriteStream(destPath)
        res.pipe(file)
        file.on('finish', () => {
          file.close()
          // Mac/Linux 需要添加执行权限
          if (!isWin) { try { fs.chmodSync(destPath, 0o755) } catch (_) {} }
          resolve(destPath)
        })
        file.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('下载超时')) })
      req.end()
    }
    followRedirect(url)
  })
}

function runYtDlp(ytDlpPath, args) {
  // 自动注入 --js-runtimes node
  let fullArgs = ['--js-runtimes', 'node'].concat(args)
  // 自动注入 cookies 文件（如果已配置）
  const settings = store.get('aiSettings', {})
  const cookiesFile = settings.ytCookiesFile || ''
  if (cookiesFile && require('fs').existsSync(cookiesFile)) {
    fullArgs = ['--cookies', cookiesFile].concat(fullArgs)
  }
  return new Promise((resolve, reject) => {
    execFile(ytDlpPath, fullArgs, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) { reject(new Error(stderr || err.message)); return }
      resolve(stdout || '')
    })
  })
}

ipcMain.handle('youtube-to-note', async (event, { videoUrl, userPrompt }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }

  const sendProgress = (msg) => {
    try { event.sender.send('youtube-note-progress', msg) } catch (_) {}
  }

  let tmpDir = null
  try {
    // 1. 规范化 URL
    let cleanUrl = videoUrl.trim()
    if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl
    if (cleanUrl.includes('youtu.be/')) {
      const vid = cleanUrl.split('youtu.be/')[1].split('?')[0]
      cleanUrl = 'https://www.youtube.com/watch?v=' + vid
    }

    // 2. 确保 yt-dlp 可用
    const ytDlpPath = await ensureYtDlp(sendProgress)
    sendProgress('正在获取视频信息...')

    // 3. 获取视频信息
    const infoJson = await runYtDlp(ytDlpPath, [
      '--extractor-args', 'youtube:player_client=android',
      '--dump-json', '--no-playlist', '--no-warnings', cleanUrl
    ])
    const info = JSON.parse(infoJson)
    const videoTitle = info.title || '未知标题'
    const author = info.uploader || info.channel || '未知作者'
    const lengthSeconds = info.duration || 0
    const duration = Math.floor(lengthSeconds / 60) + '分钟' + (lengthSeconds % 60) + '秒'

    sendProgress('已获取视频：' + videoTitle)

    // 4. 临时目录
    tmpDir = path.join(os.tmpdir(), 'yt-captions-' + Date.now())
    fs.mkdirSync(tmpDir, { recursive: true })

    // 5. 尝试下载软字幕
    sendProgress('正在尝试获取字幕轨道...')
    let rawText = ''
    let captionLang = ''
    let usedVision = false

    try {
      await runYtDlp(ytDlpPath, [
        '--extractor-args', 'youtube:player_client=android',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'zh-Hans,zh-Hant,zh,en,en-US,en-GB',
        '--sub-format', 'vtt', '--skip-download',
        '--no-playlist', '--no-warnings',
        '-o', path.join(tmpDir, 'caption'), cleanUrl
      ])
    } catch (_) {}

    const vttFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt'))

    if (vttFiles.length > 0) {
      // ─── 路径A：有软字幕 ───
      const zhFile = vttFiles.find(f => f.includes('.zh') || f.includes('zh-Hans') || f.includes('zh-Hant'))
      const enFile = vttFiles.find(f => f.includes('.en'))
      const selectedFile = zhFile || enFile || vttFiles[0]
      captionLang = zhFile ? 'zh' : (enFile ? 'en' : 'other')
      const vttContent = fs.readFileSync(path.join(tmpDir, selectedFile), 'utf-8')
      rawText = parseVttCaption(vttContent)
      sendProgress('已获取字幕轨道，AI 整理中...')

    } else {
      // ─── 路径B：无软字幕，用 AI 视觉识别硬字幕 ───
      if (!settings.audioModelId) {
        return {
          success: false,
          error: '该视频使用的是硬字幕（烧录在画面里），需要 AI 视觉识别。\n\n请在「系统设置」中配置「音频模型 ID」（Doubao-Seed 全模态模型接入点），程序即可自动识别画面中的字幕。'
        }
      }

      sendProgress('未找到字幕轨道（硬字幕），正在下载视频片段...')

      // 下载最低画质视频（前5分钟）
      const videoPath = path.join(tmpDir, 'video.mp4')
      const maxSec = Math.min(lengthSeconds, 300)
      const endTime = Math.floor(maxSec / 60) + ':' + String(maxSec % 60).padStart(2, '0')

      // 使用 android 客户端下载（绕过 YouTube 403 限制），最低画质
      try {
        await runYtDlp(ytDlpPath, [
          '--extractor-args', 'youtube:player_client=android',
          '--format', 'worst',
          '--no-playlist', '--no-warnings',
          '-o', videoPath, cleanUrl
        ])
      } catch (e) {
        return { success: false, error: '视频下载失败：' + e.message }
      }

      if (!fs.existsSync(videoPath)) {
        return { success: false, error: '视频下载失败，请检查网络连接' }
      }

      const videoMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)
      sendProgress('视频已下载（' + videoMB + 'MB），上传至 AI 识别字幕...')

      // 上传到火山方舟 Files API
      const uploadedFileId = await uploadFileToArk(
        settings.apiKey, settings.endpoint, videoPath
      )

      // 等待文件处理完毕（status 变为 active），否则调用模型会报 InvalidState
      sendProgress('文件上传成功，等待服务器处理...')
      await waitFileActive(settings.apiKey, settings.endpoint, uploadedFileId)

      sendProgress('AI 视觉识别中，请稍候（约1~2分钟）...')

      // 调 Doubao 全模态模型逐帧识别字幕
      const visionReply = await callArkMultimodal(
        settings.apiKey, settings.audioModelId, settings.endpoint,
        uploadedFileId,
        '请完整提取这段视频中出现的所有字幕文字，按出现顺序排列。要求：1. 只输出字幕的文字内容，不要输出时间戳、序号或任何格式标记；2. 每条字幕单独一行；3. 如果没有字幕，请描述视频的主要内容。',
        videoPath
      )

      rawText = visionReply || ''
      captionLang = 'zh'
      usedVision = true
      sendProgress('字幕识别完成，AI 整理笔记中...')
    }

    if (!rawText || rawText.length < 10) {
      return { success: false, error: '未能获取到字幕内容，无法生成笔记' }
    }

    // 6. 调 DeepSeek 整理笔记
    const langNote = (captionLang === 'zh' || usedVision) ? '内容语言：中文' : ('内容语言：' + captionLang + '，请用中文输出笔记')
    const notePrompt = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : '请整理成结构清晰的笔记，包含：核心主题、主要观点、重要细节、总结'
    const sourceNote = usedVision ? '（以下内容由 AI 视觉识别视频画面字幕获得）' : ''

    const userMsg = '以下是 YouTube 视频的字幕内容' + sourceNote + '，请帮我整理成笔记。\n\n视频信息：\n- 标题：' + videoTitle + '\n- 作者：' + author + '\n- 时长：' + duration + '\n- ' + langNote + '\n\n笔记要求：' + notePrompt + '\n\n字幕内容（前8000字）：\n' + rawText.slice(0, 8000)

    const reply = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [
        { role: 'system', content: '你是一个专业的笔记整理助手，擅长从视频字幕中提炼有价值的内容。' },
        { role: 'user', content: userMsg }
      ],
      4000
    )

    sendProgress('完成！')
    return {
      success: true,
      note: reply,
      videoTitle,
      author,
      duration,
      captionLang: usedVision ? 'AI视觉识别' : captionLang,
      rawCaption: rawText,
      usedVision
    }

  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }
})

function parseVttCaption(vtt) {
  const lines = vtt.split('\n')
  const textLines = []
  const seen = new Set()

  for (const line of lines) {
    const t = line.trim()
    // 跳过空行、头部、纯数字序号、任何包含时间戳箭头的行
    if (!t) continue
    if (t === 'WEBVTT' || t.startsWith('Kind:') || t.startsWith('Language:')) continue
    if (/-->/.test(t)) continue
    if (/^\d+$/.test(t)) continue
    if (t.startsWith('NOTE') || t.startsWith('STYLE') || t.startsWith('REGION')) continue
    // 去掉 VTT 内联标签 <00:00:00.000> <c> </c> 等
    const clean = t
      .replace(/<\d{2}:\d{2}:\d{2}\.\d+>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim()
    if (clean && !seen.has(clean)) {
      seen.add(clean)
      textLines.push(clean)
    }
  }
  return textLines.join(' ')
}


// ── 网页内容转笔记 ──
function fetchWebPage(pageUrl) {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const http = require('http')
    const url = new URL(pageUrl)
    const lib = url.protocol === 'https:' ? https : http
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      }
    }
    const req = lib.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : url.origin + res.headers.location
        fetchWebPage(redirectUrl).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
    req.end()
  })
}

ipcMain.handle('webpage-to-note', async (event, { pageUrl, userPrompt, pasteContent, pasteTitle }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }
  const sendProgress = (msg) => {
    try { event.sender.send('webpage-note-progress', msg) } catch (_) {}
  }
  try {
    let title = '', rawText = '', cleanUrl = pageUrl ? pageUrl.trim() : ''

    if (pasteContent && pasteContent.trim()) {
      // ── 粘贴模式：直接用用户粘贴的内容 ──
      sendProgress('正在整理粘贴的内容...')
      rawText = pasteContent.trim()
      title = pasteTitle || '粘贴内容'
      if (!cleanUrl) cleanUrl = ''

    } else {
      // ── 链接模式：抓取网页 ──
      if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl
      sendProgress('正在获取网页内容...')
      const html = await fetchWebPage(cleanUrl)
      if (!html || html.length < 100) {
        return { success: false, error: '无法获取网页内容，请检查链接是否正确或改用「粘贴模式」' }
      }

      sendProgress('正在提取正文...')
      const { JSDOM } = require('jsdom')
      const { Readability } = require('@mozilla/readability')
      const dom = new JSDOM(html, { url: cleanUrl })
      const reader = new Readability(dom.window.document)
      const article = reader.parse()

      if (article && article.textContent && article.textContent.trim().length > 100) {
        title = article.title || ''
        rawText = article.textContent.trim()
      } else {
        title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
        title = title.replace(/<[^>]+>/g, '').trim()
        rawText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, '\n')
          .trim()
          .slice(0, 15000)
      }

      if (!rawText || rawText.length < 50) {
        return { success: false, error: '网页内容为空或无法解析，请改用「粘贴模式」手动粘贴正文' }
      }
    }

    // 3. 调 DeepSeek 整理笔记
    sendProgress('AI 正在整理笔记...')
    const notePrompt = (userPrompt && userPrompt.trim())
      ? userPrompt.trim()
      : '请整理成结构清晰的笔记，包含：文章主题、核心观点、重要细节、总结'

    const userMsg = `以下是网页「${title}」的正文内容，请帮我整理成笔记。

网页链接：${cleanUrl}
笔记要求：${notePrompt}

正文内容（前10000字）：
${rawText.slice(0, 10000)}`

    const reply = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [
        { role: 'system', content: '你是一个专业的笔记整理助手，擅长从网页文章中提炼有价值的内容，输出结构清晰的 Markdown 笔记。' },
        { role: 'user', content: userMsg }
      ],
      4000
    )

    sendProgress('完成！')
    return {
      success: true,
      note: reply,
      title: title || cleanUrl,
      rawText: rawText,
      url: cleanUrl
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── 订阅追踪 ──
const { BrowserWindow: SubBrowserWindow, session } = require('electron')

function getFeedStore() { return store.get('feeds', []) }
function saveFeedStore(feeds) { store.set('feeds', feeds) }

ipcMain.handle('feed-get-all', () => getFeedStore())

ipcMain.handle('feed-mark-platform-logged-in', (event, platform) => {
  const feeds = getFeedStore()
  feeds.forEach((f, i) => { if (f.platform === platform) feeds[i].loggedIn = true })
  saveFeedStore(feeds)
  return { success: true }
})

ipcMain.handle('feed-add', (event, { platform, name, url }) => {
  const feeds = getFeedStore()
  feeds.push({ platform, name, url, lastCheck: null, seenIds: [] })
  saveFeedStore(feeds)
  return { success: true }
})

ipcMain.handle('feed-delete', (event, index) => {
  const feeds = getFeedStore()
  feeds.splice(index, 1)
  saveFeedStore(feeds)
  return { success: true }
})

// 各平台登录检测：检查 cookies 里有没有登录凭证
async function checkPlatformLogin(platform, ses) {
  const cookies = await ses.cookies.get({})
  const cookieMap = {}
  cookies.forEach(c => { cookieMap[c.name] = c.value })

  switch (platform) {
    case 'xiaohongshu':
      return !!(cookieMap['web_session'] || cookieMap['a1'] || cookieMap['webId'])
    case 'x':
      return !!(cookieMap['auth_token'] || cookieMap['ct0'])
    case 'instagram':
      return !!(cookieMap['sessionid'] || cookieMap['ds_user_id'])
    case 'facebook':
      return !!(cookieMap['c_user'] || cookieMap['xs'])
    default:
      return false
  }
}

ipcMain.handle('feed-open-login', async (event, index) => {
  const feeds = getFeedStore()
  const feed = feeds[index]
  if (!feed) return { success: false, error: '订阅不存在' }

  const platformUrls = {
    xiaohongshu: 'https://www.xiaohongshu.com',
    x: 'https://x.com',
    instagram: 'https://www.instagram.com',
    facebook: 'https://www.facebook.com'
  }
  const loginUrl = platformUrls[feed.platform] || feed.url
  const ses = session.fromPartition('persist:feed-' + feed.platform)

  // 先检查是否已经登录
  const alreadyLoggedIn = await checkPlatformLogin(feed.platform, ses)
  if (alreadyLoggedIn) {
    return { success: true, alreadyLoggedIn: true }
  }

  return new Promise((resolve) => {
    const loginWin = new SubBrowserWindow({
      width: 520, height: 700,
      title: '登录 ' + feed.name + '（登录成功后请关闭此窗口）',
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
    })
    loginWin.loadURL(loginUrl)
    loginWin.setMenu(null)

    // 页面跳转时持续检测登录状态
    loginWin.webContents.on('did-navigate', async () => {
      const loggedIn = await checkPlatformLogin(feed.platform, ses)
      if (loggedIn) {
        // 登录成功，更新整个平台所有订阅的登录状态
        const feeds2 = getFeedStore()
        const plat = feeds2[index]?.platform
        feeds2.forEach((f, i) => { if (f.platform === plat) feeds2[i].loggedIn = true })
        saveFeedStore(feeds2)
        // 通知渲染进程
        try { event.sender.send('feed-login-success', index) } catch (_) {}
        // 延迟关闭窗口，让用户看到成功状态
        setTimeout(() => { try { loginWin.destroy() } catch (_) {} }, 1500)
        resolve({ success: true, loggedIn: true })
      }
    })

    // 用户手动关闭窗口
    loginWin.on('closed', async () => {
      const loggedIn = await checkPlatformLogin(feed.platform, ses)
      if (loggedIn) {
        const feeds2 = getFeedStore()
        feeds2.forEach((f, i) => { if (f.platform === feed.platform) feeds2[i].loggedIn = true })
        saveFeedStore(feeds2)
        try { event.sender.send('feed-login-success', index) } catch (_) {}
        resolve({ success: true, loggedIn: true })
      } else {
        resolve({ success: true, loggedIn: false })
      }
    })
  })
})

ipcMain.handle('feed-check-login', async (event, index) => {
  const feeds = getFeedStore()
  const feed = feeds[index]
  if (!feed) return { loggedIn: false }
  const ses = session.fromPartition('persist:feed-' + feed.platform)
  const loggedIn = await checkPlatformLogin(feed.platform, ses)
  if (loggedIn && !feed.loggedIn) {
    feeds[index].loggedIn = true
    saveFeedStore(feeds)
  }
  return { loggedIn }
})

function getYoutubeChannelRssUrl(url) {
  const m = url.match(/channel\/(UC[\w-]+)/)
  if (m) return 'https://www.youtube.com/feeds/videos.xml?channel_id=' + m[1]
  return null
}

async function fetchYoutubeRss(url) {
  if (url.includes('feeds/videos.xml')) return url
  const directRss = getYoutubeChannelRssUrl(url)
  if (directRss) return directRss
  const html = await fetchWebPage(url)
  const match = html && (html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/channel\/(UC[\w-]+)/))
  if (match) return 'https://www.youtube.com/feeds/videos.xml?channel_id=' + match[1]
  return null
}

async function parseYoutubeRss(rssUrl) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    const req = https.get(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        const items = []
        const re = /<entry>([\s\S]*?)<\/entry>/g
        let m
        while ((m = re.exec(data)) !== null) {
          const e = m[1]
          const id = (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1] || ''
          const title = (e.match(/<title>(.*?)<\/title>/) || [])[1] || ''
          const published = (e.match(/<published>(.*?)<\/published>/) || [])[1] || ''
          const summary = (e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1]?.slice(0, 200) || ''
          if (id) items.push({ id, title, url: 'https://www.youtube.com/watch?v=' + id, publishedAt: published, type: 'video', summary })
        }
        resolve(items)
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('RSS 请求超时')) })
  })
}

async function checkFeedByBrowser(feed, ses) {
  const { BrowserWindow: BW } = require('electron')
  return new Promise((resolve) => {
    const win = new BW({ width: 1200, height: 800, show: false,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true } })
    win.loadURL(feed.url)
    const timeout = setTimeout(() => { try { win.destroy() } catch (_) {}; resolve([]) }, 25000)
    win.webContents.on('did-finish-load', async () => {
      clearTimeout(timeout)
      try {
        await new Promise(r => setTimeout(r, 3000))
        const platform = feed.platform
        const items = await win.webContents.executeJavaScript(`
          (function() {
            const items = [], platform = '${feed.platform}'
            if (platform === 'xiaohongshu') {
              document.querySelectorAll('section.note-item, .note-item').forEach(el => {
                const title = el.querySelector('.title, .desc, .footer .title')?.textContent?.trim() || ''
                const a = el.querySelector('a')
                const link = a ? (a.href.startsWith('http') ? a.href : 'https://www.xiaohongshu.com' + a.getAttribute('href')) : ''
                const type = el.querySelector('video, .video-mask') ? 'video' : 'article'
                if (link) items.push({ title, url: link, type, summary: '', id: link.split('?')[0] })
              })
            } else if (platform === 'x') {
              document.querySelectorAll('article[data-testid="tweet"]').forEach(el => {
                const text = el.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || ''
                const linkEl = el.querySelector('a[href*="/status/"]')
                const link = linkEl?.href || ''
                const type = el.querySelector('video,[data-testid="videoPlayer"]') ? 'video' : el.querySelector('[data-testid="tweetPhoto"]') ? 'image' : 'tweet'
                if (link) items.push({ title: text.slice(0,100), url: link, type, summary: text.slice(0,200), id: link.split('?')[0] })
              })
            } else if (platform === 'instagram') {
              document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]').forEach(el => {
                const link = el.href || ''
                const alt = el.querySelector('img')?.alt || ''
                const isReel = link.includes('/reel/')
                if (link) items.push({ title: alt.slice(0,100) || (isReel ? '视频' : '图片'), url: link, type: isReel ? 'video' : 'image', summary: alt.slice(0,200), id: link.split('?')[0] })
              })
            } else if (platform === 'facebook') {
              document.querySelectorAll('[role="article"]').forEach(el => {
                const text = el.querySelector('[data-ad-preview="message"]')?.textContent?.trim() || el.querySelector('p')?.textContent?.trim() || ''
                const a = el.querySelector('a[href*="/posts/"],a[href*="/videos/"],a[href*="/photo"]')
                const link = a?.href || ''
                const type = el.querySelector('video') ? 'video' : text ? 'article' : 'unknown'
                if (link || text) items.push({ title: text.slice(0,100) || '内容', url: link, type, summary: text.slice(0,200), id: (link||text).slice(0,80) })
              })
            }
            return [...new Map(items.map(x=>[x.id,x])).values()].slice(0,20)
          })()
        `)
        try { win.destroy() } catch (_) {}
        resolve(items || [])
      } catch (e) {
        try { win.destroy() } catch (_) {}
        resolve([])
      }
    })
  })
}

async function doCheckFeed(feed) {
  if (feed.platform === 'youtube') {
    const rssUrl = await fetchYoutubeRss(feed.url)
    if (!rssUrl) throw new Error('无法获取频道 RSS 地址，请检查链接格式')
    return await parseYoutubeRss(rssUrl)
  } else {
    const ses = session.fromPartition('persist:feed-' + feed.platform)
    return await checkFeedByBrowser(feed, ses)
  }
}

ipcMain.handle('feed-check-one', async (event, index) => {
  const feeds = getFeedStore()
  const feed = feeds[index]
  if (!feed) return { success: false, error: '订阅不存在' }
  try {
    let allItems = await doCheckFeed(feed)
    const isFirstCheck = !feed.lastCheck

    if (isFirstCheck) {
      // 第一次检查：只保留今日发布的内容
      const todayStart = new Date(); todayStart.setHours(0,0,0,0)
      const todayItems = allItems.filter(it => {
        if (!it.publishedAt) return false
        return new Date(it.publishedAt) >= todayStart
      })
      // 记录所有内容为已读（包括今日之前的）
      feeds[index].seenIds = allItems.map(it => it.id).slice(-200)
      feeds[index].lastCheck = new Date().toISOString()
      saveFeedStore(feeds)

      const todayMapped = todayItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
      return { success: true, items: todayMapped, isFirstCheck: true, sourceName: feed.name, hasToday: todayMapped.length > 0 }
    }

    // 后续检查：只返回上次检查之后新发布且未读的内容
    const lastCheckTime = new Date(feed.lastCheck)
    let newItems = allItems.filter(it => {
      if ((feed.seenIds || []).includes(it.id)) return false
      if (it.publishedAt && new Date(it.publishedAt) <= lastCheckTime) return false
      return true
    })
    newItems = newItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
    feeds[index].seenIds = [...(feed.seenIds || []), ...newItems.map(it => it.id)].slice(-200)
    feeds[index].lastCheck = new Date().toISOString()
    saveFeedStore(feeds)
    return { success: true, items: newItems }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('feed-check-all', async (event) => {
  const feeds = getFeedStore()
  const allItems = []
  const firstCheckResults = []
  for (let i = 0; i < feeds.length; i++) {
    try {
      const feed = feeds[i]
      let items = await doCheckFeed(feed)
      const isFirstCheck = !feed.lastCheck

      if (isFirstCheck) {
        const todayStart = new Date(); todayStart.setHours(0,0,0,0)
        const todayItems = items.filter(it => it.publishedAt && new Date(it.publishedAt) >= todayStart)
        feeds[i].seenIds = items.map(it => it.id).slice(-200)
        feeds[i].lastCheck = new Date().toISOString()
        const mapped = todayItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
        firstCheckResults.push({ name: feed.name, count: mapped.length })
        allItems.push(...mapped)
      } else {
        const lastCheckTime = new Date(feed.lastCheck)
        let newItems = items.filter(it => {
          if ((feed.seenIds || []).includes(it.id)) return false
          if (it.publishedAt && new Date(it.publishedAt) <= lastCheckTime) return false
          return true
        })
        newItems = newItems.map(it => ({ ...it, platform: feed.platform, sourceName: feed.name }))
        feeds[i].seenIds = [...(feed.seenIds || []), ...newItems.map(it => it.id)].slice(-200)
        feeds[i].lastCheck = new Date().toISOString()
        allItems.push(...newItems)
      }
    } catch (_) {}
  }
  saveFeedStore(feeds)
  return { success: true, items: allItems, firstCheckResults }
})
