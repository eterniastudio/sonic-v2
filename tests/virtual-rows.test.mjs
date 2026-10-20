import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// The window arithmetic is pure; React is stubbed because only the hook uses it.
function loadVirtualRows() {
  const url = new URL('../src/renderer/src/lib/virtualRows.ts', import.meta.url)
  const compiled = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  const module = { exports: {} }
  new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename: url.pathname })
    .runInThisContext()(name => {
      assert.equal(name, 'react')
      return { useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] }
    }, module, module.exports)
  return module.exports
}

const { visibleRowRange, autoFillColumns, withPinned } = loadVirtualRows()

test('the visible range covers the viewport plus overscan and stays inside the list', () => {
  const base = { viewportHeight: 520, offset: 0, rowHeight: 52, count: 1000, overscan: 6 }
  assert.deepEqual(visibleRowRange({ ...base, scrollTop: 0 }), { start: 0, end: 16 })
  assert.deepEqual(visibleRowRange({ ...base, scrollTop: 5200 }), { start: 94, end: 116 })
  // Content that starts below a header shifts the window by that offset.
  assert.deepEqual(visibleRowRange({ ...base, scrollTop: 5200, offset: 40 }), { start: 93, end: 116 })
  // Scrolled past the end (for example after the list shrank): the window clamps to the list.
  assert.deepEqual(visibleRowRange({ ...base, scrollTop: 1e7 }), { start: 1000, end: 1000 })
  assert.deepEqual(visibleRowRange({ ...base, count: 0, scrollTop: 0 }), { start: 0, end: 0 })
  assert.deepEqual(visibleRowRange({ ...base, rowHeight: 0, scrollTop: 0 }), { start: 0, end: 0 })
})

test('grid columns match repeat(auto-fill, minmax(min, 1fr)) with a gap', () => {
  assert.equal(autoFillColumns(259, 260, 8), 1)
  assert.equal(autoFillColumns(260, 260, 8), 1)
  assert.equal(autoFillColumns(528, 260, 8), 2)
  assert.equal(autoFillColumns(527, 260, 8), 1)
  assert.equal(autoFillColumns(1200, 260, 8), 4)
  assert.equal(autoFillColumns(0, 260, 8), 1)
})

test('pinned rows outside the window stay mounted, once, in order', () => {
  assert.deepEqual(withPinned({ start: 10, end: 13 }, [], 100), [10, 11, 12])
  assert.deepEqual(withPinned({ start: 10, end: 13 }, [90, 2, 11, 90], 100), [2, 10, 11, 12, 90])
  // Out-of-range pins (a stale index) and a window past the end are dropped.
  assert.deepEqual(withPinned({ start: 98, end: 104 }, [-1, 100, 250], 100), [98, 99])
})
