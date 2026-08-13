const { contextBridge, ipcRenderer } = require('electron')
const { webUtils } = require('electron/renderer')

// preload 层监听 drop，获取真实路径后通过 ipcRenderer 发回渲染进程
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return
    const paths = Array.from(e.dataTransfer.files).map(f => {
      try { return webUtils.getPathForFile(f) } catch (_) { return null }
    }).filter(Boolean)
    if (paths.length > 0) ipcRenderer.send('renderer-files-dropped', paths)
  }, true)

  ipcRenderer.on('files-dropped-reply', (_e, paths) => {
    window.dispatchEvent(new CustomEvent('files-dropped', { detail: paths }))
  })
})

contextBridge.exposeInMainWorld('api', {
  selectVault:       ()          => ipcRenderer.invoke('select-vault'),
  getVaultPath:      ()          => ipcRenderer.invoke('get-vault-path'),
  getVaultStats:     (vaultPath) => ipcRenderer.invoke('get-vault-stats', vaultPath),
  searchFiles:       (args)      => ipcRenderer.invoke('search-files', args),
  openFile:          (filePath)  => ipcRenderer.invoke('open-file', filePath),
  openInObsidian:    (filePath)  => ipcRenderer.invoke('open-in-obsidian', filePath),
  importFiles:       (args)      => ipcRenderer.invoke('import-files', args),
  selectImportFiles: ()          => ipcRenderer.invoke('select-import-files'),
  getVaultFolders:   (vaultPath) => ipcRenderer.invoke('get-vault-folders', vaultPath),
  listFolderFiles:   (args)      => ipcRenderer.invoke('list-folder-files', args),
  listFilesByType:   (args)      => ipcRenderer.invoke('list-files-by-type', args),
  selectInbox:       ()          => ipcRenderer.invoke('select-inbox'),
  getInboxPath:      ()          => ipcRenderer.invoke('get-inbox-path'),
  listInboxFiles:    (inboxPath) => ipcRenderer.invoke('list-inbox-files', inboxPath),
  checkDuplicates:   (vaultPath) => ipcRenderer.invoke('check-duplicate-files', vaultPath),
  checkEmptyFiles:   (vaultPath) => ipcRenderer.invoke('check-empty-files', vaultPath),
  deleteFile:        (filePath)  => ipcRenderer.invoke('delete-file', filePath),
  getTagStats:       (vaultPath) => ipcRenderer.invoke('get-tag-stats', vaultPath),
  searchByTag:       (args)      => ipcRenderer.invoke('search-by-tag', args),
  createNote:        (args)      => ipcRenderer.invoke('create-note', args),
  moveNote:          (args)      => ipcRenderer.invoke('move-note', args),
  saveAiSettings:    (settings)  => ipcRenderer.invoke('save-ai-settings', settings),
  getAiSettings:     ()          => ipcRenderer.invoke('get-ai-settings'),
  selectInboxFolder: ()          => ipcRenderer.invoke('select-inbox-folder'),
  aiClassifyFile:    (args)      => ipcRenderer.invoke('ai-classify-file', args),
  aiImportFiles:     (args)      => ipcRenderer.invoke('ai-import-files', args),
  getProcessedFolder:(inboxPath) => ipcRenderer.invoke('get-processed-folder', inboxPath),
  clearProcessedFolder:(inboxPath)=> ipcRenderer.invoke('clear-processed-folder', inboxPath),
  aiAnalyzeFolder:   (args)      => ipcRenderer.invoke('ai-analyze-folder', args),
  onAnalyzeProgress: (cb)        => ipcRenderer.on('ai-analyze-progress', (_e, data) => cb(data)),
  offAnalyzeProgress:()          => ipcRenderer.removeAllListeners('ai-analyze-progress'),
  getFolderTree:     (vaultPath) => ipcRenderer.invoke('get-folder-tree', vaultPath),
  getFolderMdFiles:  (folderPath)=> ipcRenderer.invoke('get-folder-md-files', folderPath),
  onFilesDropped:    (cb)        => ipcRenderer.on('files-dropped-reply', (_e, paths) => cb(paths)),
})
