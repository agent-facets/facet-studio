import { spawn } from 'node:child_process'
import { type } from 'arktype'
import { cliPath } from './install'
import type { CatalogEntry } from './catalog'

export const registryName = '@agentfacets/meeting-to-action'

/** Declare a stable bridge contract without supplying any application code. @param version Exact registry version. @returns Supported app metadata. */
export function registryEntry(version = '0.0.0'): CatalogEntry {
  return {
    id: 'meeting-to-action',
    name: registryName,
    description:
      'Registry-delivered meeting worksheet. Review decisions, action items, owners and dates.',
    version,
    source: 'registry',
    sourcePath: '',
    skillPath: '',
    companions: [],
    descriptor: {
      schemaVersion: 1,
      id: 'meeting-to-action',
      version,
      runtime: 'bun',
      entrypoint: 'assets/server.js',
      openTool: 'meeting_open',
    },
  }
}

/** Parse the installed CLI's documented presentation format without treating malformed output as an empty search. @param output Captured noninteractive output. @returns Exact scoped package versions. */
export function parseRegistrySearch(
  output: string,
): { name: string; version: string }[] {
  const lines = output
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trim()
    .split(/\r?\n/)
  const header = lines.shift() ?? ''
  const count = /\.\.\.found (?:(\d+) match(?:es)?\.|no matches\.)$/.exec(
    header,
  )
  if (!count || !header.startsWith('Searching registry'))
    throw new Error(
      'The Facet CLI search output is unsupported. Update the CLI and retry.',
    )
  const expected = Number(count[1] ?? 0)
  const results = lines
    .filter((line) => line.trim())
    .map((line) => {
      const row =
        /^\s*(@[a-z0-9-]+\/[a-z0-9-]+)\s+v(\d+\.\d+\.\d+)\s+·\s+by\s+.+\s+·/.exec(
          line,
        )
      if (!row)
        throw new Error(
          'The Facet CLI search output is unsupported. Update the CLI and retry.',
        )
      return { name: row[1]!, version: row[2]! }
    })
  if (
    results.length !== expected ||
    results.length > 100 ||
    new Set(results.map((result) => result.name)).size !== results.length
  )
    throw new Error('The Facet CLI search output is incomplete.')
  return results
}

/** Run read-only CLI commands using its own OAuth session with bounded output and cancellation. @param args Fixed command arguments. @param signal Request cancellation. @returns Captured stdout. */
export async function registryCommand(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('Registry search cancelled.')
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', COLUMNS: '400' },
      detached: process.platform !== 'win32',
    })
    let output = ''
    let bytes = 0
    let settled = false
    /** Settle once and clean up owned listeners. @param error Safe failure. @returns Nothing. */
    function finish(error?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve(output)
    }
    /** Stop the owned process group and fail with a safe message. @returns Nothing. */
    function cancel(): void {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
      finish(
        new Error(
          'Registry request cancelled, timed out, or exceeded its output limit.',
        ),
      )
    }
    const timer = setTimeout(cancel, 20000)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > 131072) cancel()
      else output += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > 131072) cancel()
    })
    child.once('error', () =>
      finish(new Error('The Facet CLI could not start.')),
    )
    child.once('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              'Registry access failed. Sign in with facet login and verify organization access.',
            ),
      ),
    )
    if (signal?.aborted) cancel()
  })
}

/** Search actual authenticated registry results with bounded keyword fallback. @param query User intent. @param signal Cancellation. @param run CLI adapter for protocol tests. @returns Supported app results from the registry. */
export async function searchRegistry(
  query: string,
  signal?: AbortSignal,
  run = registryCommand,
): Promise<CatalogEntry[]> {
  await run(['whoami'], signal)
  const words = query.toLowerCase().match(/[a-z0-9-]+/g) ?? []
  const keywords = [
    ...new Set(
      words.filter(
        (word) =>
          ![
            'can',
            'you',
            'find',
            'me',
            'a',
            'facet',
            'to',
            'organize',
            'my',
            'into',
            'the',
            'and',
            'help',
          ].includes(word),
      ),
    ),
  ].slice(0, 3)
  const searches = keywords.length ? keywords : ['@agentfacets']
  const results = new Map<string, CatalogEntry>()
  for (const keyword of searches) {
    const rows = parseRegistrySearch(await run(['search', keyword], signal))
    for (const row of rows)
      if (row.name === registryName)
        results.set(row.name, registryEntry(row.version))
    if (results.size) break
  }
  return [...results.values()]
}

/** Recover only the supported registry version from the CLI receipt before full byte verification. @param value Parsed lock JSON. @returns App metadata or no trusted identity. */
export function registryEntryFromLock(
  value: unknown,
): CatalogEntry | undefined {
  const lock = type({ facets: { '[string]': 'unknown' } })(value)
  if (lock instanceof type.errors) return
  const receipt = type({
    version: /^\d+\.\d+\.\d+$/,
    source: { kind: "'registry'", registry: "'https://api.agentfacets.io'" },
  })(lock.facets[registryName])
  if (receipt instanceof type.errors) return
  return registryEntry(receipt.version)
}
