import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { type } from 'arktype'
import { findInstalledApp } from '../src/catalog'
import { registryEntry } from '../src/registry'

const project = await mkdtemp(join(tmpdir(), 'studio-real-registry-'))
const client = new Client({ name: 'registry-smoke', version: '1' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dir, '../dist/studio-server.js')],
  cwd: '/tmp',
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    FACET_STUDIO_PROJECT: project,
  },
})
try {
  await client.connect(transport)
  const before = await client.listTools()
  const bridge = before.tools.find((tool) =>
    tool.name.startsWith('studio_app_'),
  )
  if (!bridge) throw new Error('Missing predeclared bridge.')
  const premature = await client.callTool({ name: bridge.name, arguments: {} })
  if (!premature.isError) throw new Error('Uninstalled app opened.')
  const searched = await client.callTool(
    {
      name: 'studio_search',
      arguments: { query: 'meeting notes action items' },
    },
    undefined,
    { timeout: 90000 },
  )
  if (searched.isError) throw new Error(JSON.stringify(searched.content))
  const result = type({
    query: 'string',
    items: type({
      id: 'string',
      name: 'string',
      version: 'string',
      source: "'registry'",
      installed: 'boolean',
    }).array(),
  }).assert(searched.structuredContent)
  const item = result.items[0]
  if (!item || item.installed)
    throw new Error('Expected fresh actual registry result.')
  const stale = await client.callTool({
    name: 'studio_install',
    arguments: { id: item.id, version: '0.0.0' },
  })
  if (!stale.isError || (await Bun.file(join(project, 'facets.lock')).exists()))
    throw new Error('Unreviewed version was installed.')
  const installed = await client.callTool(
    {
      name: 'studio_install',
      arguments: { id: item.id, version: item.version },
    },
    undefined,
    { timeout: 90000 },
  )
  if (installed.isError) throw new Error(JSON.stringify(installed.content))
  const verified = await findInstalledApp(registryEntry(item.version), project)
  if (!verified)
    throw new Error(
      'Registry provenance or installed bytes failed verification.',
    )
  const opened = await client.callTool({ name: bridge.name, arguments: {} })
  if (opened.isError)
    throw new Error('Cached bridge failed to open registry-installed app.')
  const resource = bridge._meta?.['ui/resourceUri']
  if (typeof resource !== 'string') throw new Error('Missing app resource.')
  const read = await client.readResource({ uri: resource })
  const html = read.contents[0]
  if (
    !html ||
    !('text' in html) ||
    html.text !==
      (await Bun.file(join(verified.root, 'assets/view.html')).text())
  )
    throw new Error(
      'UI resource did not come from the installed registry package.',
    )
  console.log(
    JSON.stringify({
      verified: true,
      project,
      package: item.name,
      version: item.version,
      source: 'registry',
      installedServer: verified.entrypoint,
      resourceMatchesInstalledHtml: true,
      cachedBridge: bridge.name,
    }),
  )
} finally {
  await client.close()
}
