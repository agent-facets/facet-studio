import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  companionPath,
  parseDescriptor,
  loadCatalog,
  findInstalledApp,
} from './catalog'
import { createHash } from 'node:crypto'
import { localSourcePath, runFacetInstall } from './install'
import { toolAlias } from './app-proxy'

const descriptor = {
  schemaVersion: 1,
  id: 'test-app',
  version: '1.0.0',
  runtime: 'bun',
  entrypoint: 'assets/server.js',
  openTool: 'open',
}

test('app descriptors reject traversal, absolute paths and unsupported runtimes', () => {
  for (const path of [
    '../server.js',
    '/tmp/server.js',
    'assets/../../server.js',
    'assets\\server.js',
  ])
    expect(() => companionPath(path)).toThrow()
  expect(() => parseDescriptor({ ...descriptor, runtime: 'node' })).toThrow()
  expect(() =>
    parseDescriptor({ ...descriptor, entrypoint: '../server.js' }),
  ).toThrow()
  expect(() => parseDescriptor({ ...descriptor, id: 'invalid/id' })).toThrow()
  expect(parseDescriptor(descriptor).entrypoint).toBe('assets/server.js')
})

test('namespaced tool names are bounded and distinct', () => {
  const name = toolAlias('a'.repeat(48), 'x'.repeat(128))
  expect(name.length).toBeLessThanOrEqual(64)
  expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(toolAlias('one', 'open')).not.toBe(toolAlias('two', 'open'))
  expect(toolAlias('one', 'a/b')).not.toBe(toolAlias('one', 'a_b'))
})

test('installed companion verification rejects tampering and symlinks', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'catalog-verification-'))
  const source = join(fixture, 'package/skills/example')
  const installed = join(fixture, 'project/.agents/skills/example')
  for (const root of [source, installed]) {
    await mkdir(join(root, 'assets'), { recursive: true })
    await Bun.write(join(root, 'SKILL.md'), '# Example')
    await Bun.write(join(root, 'app.json'), JSON.stringify(descriptor))
    await Bun.write(join(root, 'assets/server.js'), 'console.log("fixture")')
  }
  await Bun.write(
    join(fixture, 'package/facet.json'),
    JSON.stringify({
      name: 'example',
      version: '1.0.0',
      skills: { example: { files: ['app.json', 'assets/server.js'] } },
    }),
  )
  await Bun.write(
    join(fixture, 'catalog.json'),
    JSON.stringify({
      entries: [{ id: 'example', source: 'local', path: 'package' }],
    }),
  )
  const [entry] = await loadCatalog(join(fixture, 'catalog.json'))
  expect(entry).toBeDefined()
  const project = join(fixture, 'project')
  expect(await findInstalledApp(entry!, project)).toBeUndefined()
  const files = await Promise.all(
    entry!.companions.map(async (file) => ({
      path: `skills/example/${file}`,
      integrity: `sha256:${createHash('sha256')
        .update(await Bun.file(join(source, file)).bytes())
        .digest('hex')}`,
    })),
  )
  await Bun.write(
    join(project, 'facets.lock'),
    JSON.stringify({
      facets: {
        example: {
          version: '1.0.0',
          source: {
            kind: 'local',
            path: localSourcePath(entry!.sourcePath, project),
          },
          assets: [
            {
              type: 'skill',
              name: 'example',
              scope: 'project',
              materialization: { kind: 'authored' },
              files,
            },
          ],
        },
      },
    }),
  )
  expect(await findInstalledApp(entry!, project)).toBeDefined()
  await Bun.write(join(installed, 'assets/server.js'), 'changed')
  expect(
    await findInstalledApp(entry!, join(fixture, 'project')),
  ).toBeUndefined()
  const linked = join(fixture, 'linked/.agents/skills')
  await mkdir(linked, { recursive: true })
  await symlink(source, join(linked, 'example'))
  expect(
    await findInstalledApp(entry!, join(fixture, 'linked')),
  ).toBeUndefined()
})

test('catalogue rejects duplicate app identities before activation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'catalog-duplicate-'))
  for (const name of ['one', 'two']) {
    const skill = join(fixture, name, 'skills/example')
    await mkdir(join(skill, 'assets'), { recursive: true })
    await Bun.write(join(skill, 'SKILL.md'), '# Example')
    await Bun.write(join(skill, 'app.json'), JSON.stringify(descriptor))
    await Bun.write(join(skill, 'assets/server.js'), 'fixture')
    await Bun.write(
      join(fixture, name, 'facet.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        skills: { example: { files: ['app.json', 'assets/server.js'] } },
      }),
    )
  }
  await Bun.write(
    join(fixture, 'catalog.json'),
    JSON.stringify({
      entries: [
        { id: 'one', source: 'local', path: 'one' },
        { id: 'two', source: 'local', path: 'two' },
      ],
    }),
  )
  await expect(loadCatalog(join(fixture, 'catalog.json'))).rejects.toThrow(
    'App IDs must be unique',
  )
})

test('CLI cancellation and timeout force-stop a process that ignores SIGTERM', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'install-cancel-'))
  const cli = join(fixture, 'fixture-cli')
  await Bun.write(cli, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n')
  const { chmod } = await import('node:fs/promises')
  await chmod(cli, 0o700)
  const controller = new AbortController()
  const operation = runFacetInstall(
    cli,
    fixture,
    fixture,
    controller.signal,
    2000,
  )
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()
  await expect(operation).rejects.toThrow('cancelled')
  expect(Date.now() - started).toBeLessThan(500)
  await expect(
    runFacetInstall(cli, fixture, fixture, undefined, 20),
  ).rejects.toThrow('timed out')
})

test('partial Studio initialization closes an already-started child', async () => {
  const { AppProxy } = await import('./app-proxy')
  const { createStudio } = await import('./studio-server')
  const { spyOn } = await import('bun:test')
  const fixture = await mkdtemp(join(tmpdir(), 'studio-startup-cleanup-'))
  const project = join(fixture, 'project')
  const pidFile = join(fixture, 'child.pid')
  const facets: Record<string, unknown> = {}
  const entries = []
  for (const id of ['first', 'second']) {
    const source = join(fixture, id)
    const original = join(source, 'skills', id)
    const materialized = join(project, '.agents/skills', id)
    const app = { ...descriptor, id }
    const code = `import {createInterface} from 'node:readline'; await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); const lines=createInterface({input:process.stdin}); lines.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'open',inputSchema:{type:'object'}}]};if(m.method==='resources/list')result={resources:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`
    for (const directory of [original, materialized]) {
      await mkdir(join(directory, 'assets'), { recursive: true })
      await Bun.write(join(directory, 'SKILL.md'), '# Fixture')
      await Bun.write(join(directory, 'app.json'), JSON.stringify(app))
      await Bun.write(join(directory, 'assets/server.js'), code)
    }
    const files = ['SKILL.md', 'app.json', 'assets/server.js']
    await Bun.write(
      join(source, 'facet.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        skills: { [id]: { files: files.slice(1) } },
      }),
    )
    facets[id] = {
      version: '1.0.0',
      source: { kind: 'local', path: localSourcePath(source, project) },
      assets: [
        {
          type: 'skill',
          scope: 'project',
          name: id,
          materialization: { kind: 'authored' },
          files: await Promise.all(
            files.map(async (file) => ({
              path: `skills/${id}/${file}`,
              integrity: `sha256:${createHash('sha256')
                .update(await Bun.file(join(original, file)).bytes())
                .digest('hex')}`,
            })),
          ),
        },
      ],
    }
    entries.push({ id, source: 'local', path: id })
  }
  await Bun.write(join(project, 'facets.lock'), JSON.stringify({ facets }))
  const catalogue = join(fixture, 'catalog.json')
  await Bun.write(catalogue, JSON.stringify({ entries }))
  const originalStart = AppProxy.start.bind(AppProxy)
  const start = spyOn(AppProxy, 'start').mockImplementation(
    async (installed, disconnected) => {
      if (installed.descriptor.id === 'second')
        throw new Error('Fixture startup failure')
      return originalStart(installed, disconnected)
    },
  )
  try {
    await expect(
      createStudio({ catalogFile: catalogue, project, html: '<html></html>' }),
    ).rejects.toThrow('could not be restored')
    const pid = Number(await Bun.file(pidFile).text())
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    start.mockRestore()
  }
})
