import { expect, test } from 'bun:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseRegistrySearch, searchRegistry, registryEntry } from './registry'
import { findInstalledApp } from './catalog'

const output =
  "Searching registry for 'meeting'...found 1 match.\n  @agentfacets/meeting-to-action  v0.1.3 · by james · 1 skill\n"
test('registry parser accepts exact CLI rows and rejects malformed or truncated responses', () => {
  expect(parseRegistrySearch(output)).toEqual([
    { name: '@agentfacets/meeting-to-action', version: '0.1.3' },
  ])
  expect(
    parseRegistrySearch('Searching registry...found no matches.\n'),
  ).toEqual([])
  for (const invalid of [
    '',
    output.replace('1 match', '2 matches'),
    output.replace('v0.1.3', 'vlatest'),
    output + 'Unexpected output',
    output.replace('1 match.', '2 matches.') + output.split('\n')[1] + '\n',
  ])
    expect(() => parseRegistrySearch(invalid)).toThrow()
})

test('registry search authenticates through CLI and passes bounded keywords without inventing results', async () => {
  const calls: string[][] = []
  const results = await searchRegistry(
    'Can you find me a facet to organize meeting notes into action items?',
    undefined,
    async (args) => {
      calls.push(args)
      return args[0] === 'whoami' ? 'signed in' : output
    },
  )
  expect(calls).toEqual([['whoami'], ['search', 'meeting']])
  expect(results[0]?.version).toBe('0.1.3')
  expect(results[0]?.source).toBe('registry')
  expect(results[0]?.companions).toEqual([])
  await expect(
    searchRegistry('meeting', undefined, async () => {
      throw new Error('auth failed')
    }),
  ).rejects.toThrow('auth failed')
})

test('registry app verification trusts exact CLI registry receipts and rejects provenance or byte changes', async () => {
  const project = await mkdtemp(join(tmpdir(), 'studio-registry-receipt-'))
  const root = join(project, '.opencode/skills/meeting-to-action')
  await mkdir(join(root, 'assets'), { recursive: true })
  const entry = registryEntry('0.1.3')
  const files = {
    'SKILL.md': '# Meeting',
    'app.json': JSON.stringify(entry.descriptor),
    'assets/server.js': 'export {}',
    'assets/view.html': '<h1>Downloaded UI</h1>',
  }
  const records = []
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(root, path), content)
    records.push({
      path: `skills/meeting-to-action/${path}`,
      integrity: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    })
  }
  const receipt = {
    integrity: `sha256:${'a'.repeat(64)}`,
    version: '0.1.3',
    source: { kind: 'registry', registry: 'https://api.agentfacets.io' },
    assets: [
      {
        type: 'skill',
        name: 'meeting-to-action',
        scope: 'project',
        materialization: { kind: 'authored' },
        files: records,
      },
    ],
  }
  const lock = { lockfileVersion: 0.3, facets: { [entry.name]: receipt } }
  await Bun.write(join(project, 'facets.lock'), JSON.stringify(lock))
  expect((await findInstalledApp(entry, project))?.root).toBe(root)
  await Bun.write(join(root, 'SKILL.md'), '# Adapter rendered skill')
  expect((await findInstalledApp(entry, project))?.root).toBe(root)
  expect(
    await findInstalledApp(registryEntry('0.1.2'), project),
  ).toBeUndefined()
  receipt.source.registry = 'https://other.example'
  await Bun.write(join(project, 'facets.lock'), JSON.stringify(lock))
  expect(await findInstalledApp(entry, project)).toBeUndefined()
  receipt.source.registry = 'https://api.agentfacets.io'
  await Bun.write(join(project, 'facets.lock'), JSON.stringify(lock))
  await Bun.write(join(root, 'assets/view.html'), '<h1>Changed UI</h1>')
  expect(await findInstalledApp(entry, project)).toBeUndefined()
})
