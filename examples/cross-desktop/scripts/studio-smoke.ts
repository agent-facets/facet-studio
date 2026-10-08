import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { type } from 'arktype'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installLocalFacet } from '../src/install'
import {
  findInstalledApp,
  parseDescriptor,
  type CatalogEntry,
} from '../src/catalog'
import studioManifest from '../studio-facet/facet.json'
import studioDescriptor from '../studio-facet/skills/facet-studio/app.json'
import { samplePlan } from '../src/model'

const root = resolve(import.meta.dir, '..')
const InstallResult = type({
  app: {
    id: 'string',
    openTool: 'string',
    toolNames: { '[string]': 'string' },
  },
})

/** Exercise a fresh connected Studio with a real local installation. @param file Portable Studio entrypoint. @returns Completed protocol gate. */
async function checkStudio(
  file: string,
  existingProject?: string,
): Promise<void> {
  const project =
    existingProject ??
    (await mkdtemp(join(tmpdir(), 'studio-catalog-install-')))
  const client = new Client({ name: 'studio-smoke', version: '1.0.0' })
  let toolChanges = 0
  let resourceChanges = 0
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    toolChanges += 1
  })
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    resourceChanges += 1
  })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [file],
      cwd: '/tmp',
      env: {
        FACET_STUDIO_PROJECT: project,
        ...(process.env.FACET_DIR ? { FACET_DIR: process.env.FACET_DIR } : {}),
      },
      stderr: 'inherit',
    }),
  )
  try {
    const before = await client.listTools()
    if (before.tools.length !== 3)
      throw new Error('Fresh Studio must expose exactly three static tools.')
    const search = await client.callTool({
      name: 'studio_search',
      arguments: { query: 'meeting' },
    })
    if (
      search.isError ||
      !JSON.stringify(search.structuredContent).includes('"source":"local"') ||
      !JSON.stringify(search.structuredContent).includes('"installed":false')
    )
      throw new Error('Local catalogue search failed.')
    const installation = await client.callTool(
      { name: 'studio_install', arguments: { id: 'meeting-to-action' } },
      undefined,
      { timeout: 90000 },
    )
    const result = InstallResult(installation.structuredContent)
    if (installation.isError || result instanceof type.errors)
      throw new Error(`Install failed: ${JSON.stringify(installation)}`)
    const after = await client.listTools()
    if (
      toolChanges < 1 ||
      resourceChanges < 1 ||
      after.tools.length !== 7 ||
      !after.tools.some((tool) => tool.name === result.app.openTool)
    )
      throw new Error(
        'Studio did not notify and publish installed capabilities.',
      )
    const opened = await client.callTool({
      name: result.app.openTool,
      arguments: {},
    })
    if (opened.isError || !opened._meta?.facetToolNames)
      throw new Error('Installed app open result omitted routing metadata.')
    const planTool = result.app.toolNames.meeting_plan
    if (!planTool) throw new Error('Missing namespaced plan tool.')
    const hostPlan = await client.callTool({
      name: planTool,
      arguments: {
        plan: {
          ...samplePlan,
          title: 'Portable Studio round trip',
          source: 'host',
        },
      },
    })
    if (
      hostPlan.isError ||
      !JSON.stringify(hostPlan.structuredContent).includes(
        'Portable Studio round trip',
      )
    )
      throw new Error('Namespaced host plan failed.')
    const resources = await client.listResources()
    const appResource = resources.resources.find((resource) =>
      resource.uri.startsWith('ui://facet-studio/apps/'),
    )
    if (!appResource)
      throw new Error('Installed UI resource was not published.')
    const resource = await client.readResource({ uri: appResource.uri })
    if (
      !resource.contents.some(
        (content) =>
          'text' in content && content.text.includes('<div id="root">'),
      )
    )
      throw new Error('Installed UI could not be read.')
    const invalid = await client.callTool({
      name: 'studio_install',
      arguments: { id: '../../arbitrary' },
    })
    if (!invalid.isError)
      throw new Error('Unknown catalogue installation was accepted.')
    console.log(
      `PASS: Studio search → real install → list_changed (${toolChanges} tools, ${resourceChanges} resources) → namespaced app open/plan/resource; project ${project}`,
    )
  } finally {
    await client.close()
  }
}

await checkStudio(resolve(root, 'dist/studio-server.js'))
const project = await mkdtemp(join(tmpdir(), 'studio-portable-install-'))
const sourcePath = resolve(root, 'studio-facet')
await installLocalFacet(sourcePath, project)
const entry: CatalogEntry = {
  id: studioManifest.name,
  name: studioManifest.name,
  version: studioManifest.version,
  description: studioManifest.description,
  source: 'local',
  sourcePath,
  skillPath: join(sourcePath, 'skills/facet-studio'),
  companions: ['SKILL.md', ...studioManifest.skills['facet-studio'].files],
  descriptor: parseDescriptor(studioDescriptor),
}
const installed = await findInstalledApp(entry, project)
if (!installed)
  throw new Error('Installed Studio companions failed byte verification.')
console.log(`Installed portable Studio: ${installed.entrypoint}`)
await checkStudio(installed.entrypoint, project)
console.log(
  'PASS: the installed Studio bundle serves its own UI and complete local catalogue from /tmp without source checkout paths.',
)

// Two independent catalogue entries exercise the single-project installation queue.
const { cp, rename } = await import('node:fs/promises')
const concurrentFixture = await mkdtemp(join(tmpdir(), 'studio-concurrent-'))
const entries = []
for (const id of ['first-app', 'second-app']) {
  const source = join(concurrentFixture, id)
  await cp(join(root, 'dist/catalogue/meeting-to-action'), source, {
    recursive: true,
  })
  const manifest = (await Bun.file(join(source, 'facet.json')).json()) as {
    name: string
    skills: Record<string, { description: string; files: string[] }>
  }
  const metadata = manifest.skills['meeting-to-action']!
  manifest.name = id
  manifest.skills = { [id]: metadata }
  await rename(
    join(source, 'skills/meeting-to-action'),
    join(source, 'skills', id),
  )
  const descriptorPath = join(source, 'skills', id, 'app.json')
  const descriptor = parseDescriptor(await Bun.file(descriptorPath).json())
  await Bun.write(descriptorPath, JSON.stringify({ ...descriptor, id }))
  await Bun.write(join(source, 'facet.json'), JSON.stringify(manifest))
  entries.push({ id, source: 'local', path: id })
}
const catalogue = join(concurrentFixture, 'catalog.json')
await Bun.write(catalogue, JSON.stringify({ entries }))
const concurrentProject = join(concurrentFixture, 'project')
const concurrentClient = new Client({
  name: 'studio-concurrent-smoke',
  version: '1',
})
await concurrentClient.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'dist/studio-server.js')],
    cwd: '/tmp',
    env: {
      FACET_STUDIO_PROJECT: concurrentProject,
      FACET_STUDIO_CATALOG: catalogue,
      ...(process.env.FACET_DIR ? { FACET_DIR: process.env.FACET_DIR } : {}),
    },
    stderr: 'inherit',
  }),
)
try {
  const results = await Promise.all(
    entries.map((entry) =>
      concurrentClient.callTool(
        { name: 'studio_install', arguments: { id: entry.id } },
        undefined,
        { timeout: 90000 },
      ),
    ),
  )
  if (results.some((result) => result.isError))
    throw new Error('Concurrent installation failed.')
  const lock = (await Bun.file(
    join(concurrentProject, 'facets.lock'),
  ).json()) as { facets: Record<string, unknown> }
  if (!entries.every((entry) => entry.id in lock.facets))
    throw new Error('Concurrent installation lost a lockfile entry.')
  if ((await concurrentClient.listTools()).tools.length !== 11)
    throw new Error('Concurrent app capabilities were lost.')
  console.log(
    'PASS: concurrent distinct catalogue installs retain both CLI lock entries and publish both app tool sets.',
  )
} finally {
  await concurrentClient.close()
}
