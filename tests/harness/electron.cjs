const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.whenReady().then(async () => {
  const hiddenTest = process.env.SONIC_TEST_HIDDEN === '1'
  const window = new BrowserWindow({
    width: 700,
    height: 550,
    show: !hiddenTest,
    webPreferences: { backgroundThrottling: !hiddenTest }
  })
  await window.loadFile(path.resolve('test-results/component-build/index.html'), {
    hash: process.argv.includes('--editor-harness') ? 'editor' : ''
  })
}).catch(error => {
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
