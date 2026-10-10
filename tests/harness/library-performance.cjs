const { app, BrowserWindow } = require('electron')
const path = require('node:path')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1200, height: 800 })
  await window.loadFile(path.resolve('test-results/library-render-harness/index.html'))
}).catch(error => { console.error(error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
