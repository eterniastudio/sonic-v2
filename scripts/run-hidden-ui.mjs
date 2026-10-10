import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

if (process.env.SONIC_PACKAGED_EXE) {
  console.error('Hidden UI testing requires the development build. Unset SONIC_PACKAGED_EXE first.')
  process.exit(1)
}

const require = createRequire(import.meta.url)
const runner = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)], {
  env: { ...process.env, SONIC_TEST_HIDDEN: '1' },
  stdio: 'inherit',
  windowsHide: true
})

runner.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
runner.once('exit', code => { process.exitCode = code ?? 1 })
