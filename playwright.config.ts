import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'
const runId = process.env.SONIC_TEST_RUN_ID ||= `${Date.now()}-${randomUUID()}`
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.mjs', workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: process.env.SONIC_TEST_REPORT || `test-results/reports/${runId}.json` }]],
  outputDir: `test-results/runs/${runId}`,
  metadata: { runId, packagedExecutable: process.env.SONIC_PACKAGED_EXE || null }
})
