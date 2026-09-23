import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root = path.resolve('test-results/baseline')
await mkdir(root, { recursive: true })
await writeFile(path.join(root, 'settings.json'), JSON.stringify({ autoStart: false, rescanIntervalMs: 0, downloadDir: path.join(root, 'exports') }))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', `--user-data-dir=${root}`], env })
try {
 const page = await app.firstWindow()
 await page.getByText('Default export format', { exact: true }).count()
 await page.getByRole('button', { name: /MP3/ }).first().click()
 const evidence = await page.locator('.t-dropdown').evaluateAll(nodes => nodes.map(n => ({ rect: n.getBoundingClientRect().toJSON(), visible: n.getAttribute('aria-hidden'), ancestors: [...(function*(){let p=n.parentElement;while(p){yield p;p=p.parentElement}})()].filter(p => /hidden|auto|scroll/.test(getComputedStyle(p).overflow)).map(p=>({tag:p.tagName,rect:p.getBoundingClientRect().toJSON(),overflow:getComputedStyle(p).overflow})), items:[...n.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.textContent}}) })))
 await page.screenshot({ path:path.join(root,'format-clipped.png') })
 await writeFile(path.join(root,'bounds.json'), JSON.stringify(evidence,null,2))
 console.log(JSON.stringify(evidence,null,2))
} finally { await app.close() }
