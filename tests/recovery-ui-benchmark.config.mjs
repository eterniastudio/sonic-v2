import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// Opt-in performance experiment. Launch failures and timing evidence remain
// separate from the offline application correctness suite.
const runId = process.env.SONIC_TEST_RUN_ID ||= `recovery-ui-benchmark-${randomUUID()}`
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'recovery-ui-benchmark.mjs',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: process.env.SONIC_TEST_REPORT || path.resolve(`test-results/reports/${runId}.json`) }]],
  outputDir: path.resolve(`test-results/runs/${runId}`),
  metadata: { runId, packagedExecutable: process.env.SONIC_PACKAGED_EXE || null }
})
