const { app, BrowserWindow } = require('electron')
const path = require('node:path')
app.whenReady().then(async () => {
  const hiddenTest = process.env.SONIC_TEST_HIDDEN === '1'
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !hiddenTest,
    webPreferences: { backgroundThrottling: !hiddenTest }
  })
  await window.loadFile(path.resolve('test-results/library-render-harness/index.html'))
}).catch(error => { console.error(error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
