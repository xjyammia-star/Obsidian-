
try {
  const e1 = require('electron')
  console.log('electron keys:', Object.keys(e1).join(', '))
  console.log('webUtils from electron:', typeof e1.webUtils)
} catch(err) { console.log('electron error:', err.message) }

try {
  const e2 = require('electron/renderer')
  console.log('electron/renderer keys:', Object.keys(e2).join(', '))
  console.log('webUtils from renderer:', typeof e2.webUtils)
} catch(err) { console.log('electron/renderer error:', err.message) }

try {
  const e3 = require('@electron/remote')
  console.log('webUtils from remote:', typeof e3.webUtils)
} catch(err) { console.log('remote error:', err.message) }
