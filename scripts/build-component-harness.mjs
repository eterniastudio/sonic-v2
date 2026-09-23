import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
await build({ configFile: false, root: path.resolve('tests/harness'), base: './', plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } }, build: { outDir: path.resolve('test-results/component-build'), emptyOutDir: true } })
