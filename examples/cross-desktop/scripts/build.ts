import { mkdir, copyFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import manifest from '../facet/facet.json'
import studioManifest from '../studio-facet/facet.json'
import meetingDescriptor from '../facet/skills/meeting-to-action/app.json'

const root = resolve(import.meta.dir, '..')
await mkdir(resolve(root, 'dist'), { recursive: true })

/** Bundle one self-contained MCP Apps document. @param entry React entrypoint. @param output HTML filename. @param title Document title. @returns Completed inline bundle. */
async function buildUi(
  entry: string,
  output: string,
  title: string,
): Promise<void> {
  const ui = await Bun.build({
    entrypoints: [resolve(root, entry)],
    outdir: resolve(root, 'dist/ui', output),
    target: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!ui.success) throw new Error(ui.logs.join('\n'))
  const js = ui.outputs.find((file) => file.path.endsWith('.js'))
  const css = ui.outputs.find((file) => file.path.endsWith('.css'))
  if (!js || !css) throw new Error('UI build did not emit JavaScript and CSS.')
  await Bun.write(
    resolve(root, 'dist', output),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${await css.text()}</style></head><body><div id="root"></div><script type="module">${(await js.text()).replaceAll('</script', '<\\/script')}</script></body></html>`,
  )
}

await buildUi('src/ui.tsx', 'view.html', 'Meeting to Action · Facet Studio')
const server = await Bun.build({
  entrypoints: [resolve(root, 'src/server.ts')],
  outdir: resolve(root, 'dist'),
  target: 'bun',
  minify: true,
})
if (!server.success) throw new Error(server.logs.join('\n'))
await mkdir(resolve(root, 'facet/skills/meeting-to-action/assets'), {
  recursive: true,
})
for (const file of ['server.js', 'view.html'])
  await copyFile(
    resolve(root, 'dist', file),
    resolve(root, 'facet/skills/meeting-to-action/assets', file),
  )

await buildUi(
  'src/studio-ui.tsx',
  'studio.html',
  'Facet Studio · Local catalogue',
)
const studio = await Bun.build({
  entrypoints: [resolve(root, 'src/studio-server.ts')],
  outdir: resolve(root, 'dist'),
  target: 'bun',
  minify: true,
})
if (!studio.success) throw new Error(studio.logs.join('\n'))
const catalogRoot = resolve(root, 'dist/catalogue', meetingDescriptor.id)
await mkdir(catalogRoot, { recursive: true })
await copyFile(
  resolve(root, 'facet/facet.json'),
  resolve(catalogRoot, 'facet.json'),
)
for (const [name, skill] of Object.entries(manifest.skills)) {
  for (const file of ['SKILL.md', ...skill.files]) {
    const target = resolve(catalogRoot, 'skills', name, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolve(root, 'facet/skills', name, file), target)
  }
}
await Bun.write(
  resolve(root, 'dist/catalog.json'),
  JSON.stringify(
    {
      entries: [
        {
          id: meetingDescriptor.id,
          source: 'local',
          path: `catalogue/${meetingDescriptor.id}`,
        },
      ],
    },
    null,
    2,
  ),
)
console.log(
  'Built portable meeting companions and Studio with its configured local catalogue.',
)

const studioAssets = resolve(root, 'studio-facet/skills/facet-studio/assets')
for (const skill of Object.values(studioManifest.skills)) {
  for (const file of skill.files.filter((file) => file.startsWith('assets/'))) {
    const path = file.slice('assets/'.length)
    const target = resolve(studioAssets, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolve(root, 'dist', path), target)
  }
}
console.log(
  'Studio facet companions include its UI, server, and complete local catalogue fixture.',
)
