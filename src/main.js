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
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
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
    aiClassifyEnabled: false,
    reminderEnabled: false,
    reminderAdvance: 0,
    inboxFolder: ''
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

// ── AI 分析文件夹（Map-Reduce：逐篇提取摘要 → 汇总生成报告）──
ipcMain.handle('ai-analyze-folder', async (event, { folderPath, userPrompt }) => {
  const settings = store.get('aiSettings', {})
  if (!settings.apiKey || !settings.modelId) {
    return { success: false, error: '请先在系统设置中配置 API Key 和模型 ID' }
  }

  // 收集文件夹内所有 md 文件（递归）
  const mdFiles = getAllFiles(folderPath, '.md')
  if (!mdFiles.length) {
    return { success: false, error: '所选文件夹内没有找到任何 Markdown 笔记' }
  }

  // ── Map 阶段：逐篇提取结构化摘要 ──
  const summaries = []
  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i]
    const fileName = path.basename(filePath, '.md')

    // 推送进度给前端
    event.sender.send('ai-analyze-progress', {
      current: i + 1,
      total: mdFiles.length,
      fileName
    })

    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 2000)
      if (!body) {
        summaries.push({ fileName, title: fileName, summary: '（文件内容为空）', keywords: [], keyPoints: [] })
        continue
      }

      const mapPrompt = `请阅读以下笔记，提取关键信息，只输出 JSON，不要加任何其他文字：
{"title":"笔记标题或核心主题（15字内）","keywords":["关键词1","关键词2","关键词3"],"summary":"核心内容一句话概括（60字内）","keyPoints":["要点1","要点2"]}

笔记文件名：${fileName}
笔记内容：
${body}`

      const reply = await callVolcanoAI(
        settings.apiKey, settings.modelId, settings.endpoint,
        [{ role: 'user', content: mapPrompt }]
      )
      const clean = reply.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      summaries.push({
        fileName,
        title: parsed.title || fileName,
        keywords: parsed.keywords || [],
        summary: parsed.summary || '',
        keyPoints: parsed.keyPoints || []
      })
    } catch (err) {
      summaries.push({ fileName, title: fileName, summary: `（解析失败）`, keywords: [], keyPoints: [] })
    }
  }

  // 推送"汇总中"状态
  event.sender.send('ai-analyze-progress', {
    current: mdFiles.length,
    total: mdFiles.length,
    fileName: '正在生成报告...',
    reducing: true
  })

  // ── Reduce 阶段：把所有摘要 + 用户需求发给 AI 生成最终内容 ──
  const summaryText = summaries.map((s, i) =>
    `【${i + 1}】${s.title || s.fileName}\n关键词：${(s.keywords || []).join('、') || '无'}\n摘要：${s.summary}\n要点：${(s.keyPoints || []).join('；') || '无'}`
  ).join('\n\n')

  const folderName = path.basename(folderPath)
  const reducePrompt = `你是一个知识管理助手。以下是知识库文件夹「${folderName}」中 ${summaries.length} 篇笔记的摘要信息。

${summaryText}

---
用户需求：${userPrompt}

请根据用户需求，基于以上所有笔记内容，生成相应的输出。用中文回答，使用 Markdown 格式。`

  try {
    const finalReply = await callVolcanoAI(
      settings.apiKey, settings.modelId, settings.endpoint,
      [{ role: 'user', content: reducePrompt }],
      4000
    )
    return { success: true, result: finalReply, fileCount: mdFiles.length, folderName }
  } catch (err) {
    return { success: false, error: '生成报告失败：' + err.message }
  }
})
