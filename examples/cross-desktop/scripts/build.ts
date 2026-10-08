import { mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
await mkdir(resolve(root, 'dist'), { recursive: true })
const ui = await Bun.build({
  entrypoints: [resolve(root, 'src/ui.tsx')],
  outdir: resolve(root, 'dist/ui'),
  target: 'browser',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!ui.success) throw new Error(ui.logs.join('\n'))
const js = ui.outputs.find((output) => output.path.endsWith('.js'))
const css = ui.outputs.find((output) => output.path.endsWith('.css'))
if (!js || !css) throw new Error('UI build did not emit JavaScript and CSS.')
await Bun.write(
  resolve(root, 'dist/view.html'),
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Meeting to Action · Facet Studio</title><style>${await css.text()}</style></head><body><div id="root"></div><script type="module">${(await js.text()).replaceAll('</script', '<\\/script')}</script></body></html>`,
)
const server = await Bun.build({
  entrypoints: [resolve(root, 'src/server.ts')],
  outdir: resolve(root, 'dist'),
  target: 'bun',
  minify: true,
})
if (!server.success) throw new Error(server.logs.join('\n'))
await mkdir(resolve(root, 'facet/skills/meeting-to-action/assets'), { recursive: true })
for (const file of ['server.js', 'view.html'])
  await copyFile(
    resolve(root, 'dist', file),
    resolve(root, 'facet/skills/meeting-to-action/assets', file),
  )
console.log(
  'Built portable server.js and view.html; facet companions are ready.',
)
