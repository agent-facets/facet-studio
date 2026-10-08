import { mkdir, copyFile, readdir, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import manifest from '../facet/facet.json'
import appDescriptor from '../facet/skills/meeting-to-action/app.json'
import skill from '../facet/skills/meeting-to-action/SKILL.md' with {
  type: 'text',
}
import hostSetup from '../facet/skills/meeting-to-action/references/host-setup.md' with {
  type: 'text',
}

/** Locate the CLI without changing shell configuration. @returns Executable path or safe failure. */
function cliPath(): string {
  const path =
    Bun.which('facet') ??
    Bun.which(
      join(process.env.FACET_DIR ?? join(homedir(), '.facet'), 'bin', 'facet'),
    )
  if (!path)
    throw new Error('Install the Facet CLI before installing this example.')
  return path
}

/** Find a materialized companion after the real CLI install. @param directory Consuming project. @returns Server path. */
async function findServer(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === '.catalog' ||
      entry.name === '.git' ||
      entry.name === 'node_modules'
    )
      continue
    const path = join(directory, entry.name)
    if (
      entry.isFile() &&
      entry.name === 'server.js' &&
      path.includes(`${join('meeting-to-action', 'assets')}/`)
    )
      return path
    if (entry.isDirectory()) {
      const found = await findServer(path)
      if (found) return found
    }
  }
}

/** Install the fixed bundled catalogue entry. @param assets Current portable server/UI directory. @param project Trusted process configuration. @returns Verified installation paths. */
export async function installFacet(
  assets: string,
  project: string,
): Promise<{ project: string; server: string }> {
  const source = join(project, '.catalog', 'meeting-to-action')
  const skillRoot = join(source, 'skills', 'meeting-to-action')
  await mkdir(join(skillRoot, 'assets'), { recursive: true })
  await mkdir(join(skillRoot, 'references'), { recursive: true })
  await Bun.write(join(source, 'facet.json'), JSON.stringify(manifest, null, 2))
  await Bun.write(join(skillRoot, 'SKILL.md'), skill)
  await Bun.write(
    join(skillRoot, 'app.json'),
    JSON.stringify(appDescriptor, null, 2),
  )
  await Bun.write(join(skillRoot, 'references', 'host-setup.md'), hostSetup)
  await copyFile(
    join(assets, 'server.js'),
    join(skillRoot, 'assets', 'server.js'),
  )
  await copyFile(
    join(assets, 'view.html'),
    join(skillRoot, 'assets', 'view.html'),
  )
  await installLocalFacet(source, project)
  const server = await findServer(project)
  if (!server || !(await Bun.file(join(server, '..', 'view.html')).exists()))
    throw new Error(
      'The CLI did not materialize the server and UI companions. Check the selected adapter.',
    )
  const command = process.execPath
  await Bun.write(
    join(project, 'claude-desktop.example.json'),
    JSON.stringify(
      {
        mcpServers: {
          'meeting-to-action': { command, args: [resolve(server)] },
        },
      },
      null,
      2,
    ),
  )
  await Bun.write(
    join(project, 'codex.example.toml'),
    `[mcp_servers.meeting-to-action]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(resolve(server))}]\n`,
  )
  return { project, server }
}

/** Resolve the fixed local staging location. @param source Trusted package directory. @param project Consuming project. @returns Deterministic local source path. */
export function localSourcePath(source: string, project: string): string {
  return join(
    project,
    '.catalog',
    createHash('sha256').update(resolve(source)).digest('hex').slice(0, 20),
  )
}

/** Stage bounded regular package files within the consuming tree required by Facet. @param source Trusted catalogue package. @param destination Fixed staging directory. @param signal Caller cancellation. @returns Completed package copy. */
async function stageSource(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  let files = 0
  let bytes = 0
  /** Copy one bounded directory without following symlinks. @param from Source directory. @param to Destination directory. @param depth Nesting bound. @returns Completion. */
  async function copy(from: string, to: string, depth: number): Promise<void> {
    if (signal?.aborted) throw new Error('Installation was cancelled.')
    if (depth > 12 || (await lstat(from)).isSymbolicLink())
      throw new Error('The local package has unsupported paths.')
    const previous = await lstat(to).catch(() => undefined)
    if (previous?.isSymbolicLink())
      throw new Error('The local install destination is unsafe.')
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue
      if (entry.isSymbolicLink())
        throw new Error('The local package contains a symbolic link.')
      const input = join(from, entry.name)
      const output = join(to, entry.name)
      if (entry.isDirectory()) await copy(input, output, depth + 1)
      else if (entry.isFile()) {
        const size = (await lstat(input)).size
        bytes += size
        if (++files > 300 || size > 4 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
          throw new Error('The local package exceeds the prototype size limit.')
        if ((await lstat(output).catch(() => undefined))?.isSymbolicLink())
          throw new Error('The local install destination is unsafe.')
        await copyFile(input, output)
      } else throw new Error('The local package contains an unsupported file.')
    }
  }
  const parent = join(destination, '..')
  if ((await lstat(parent).catch(() => undefined))?.isSymbolicLink())
    throw new Error('The local install destination is unsafe.')
  await copy(await realpath(source), destination, 0)
}

/** Run the CLI with bounded process-group cleanup. @param executable Trusted CLI path. @param source Staged local source. @param project Consuming project. @param signal Cancellation. @param timeoutMs Maximum run duration. @returns Successful child completion. */
export async function runFacetInstall(
  executable: string,
  source: string,
  project: string,
  signal?: AbortSignal,
  timeoutMs = 60000,
): Promise<void> {
  if (signal?.aborted) throw new Error('Installation was cancelled.')
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, ['add', source], {
      cwd: project,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    })
    let settled = false
    /** Finish once and remove pending timers/listeners. @param error Optional safe failure. @returns Nothing. */
    function finish(error?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolveRun()
    }
    /** Force-stop the owned process group. @returns Nothing. */
    function kill(): void {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }
    /** Cancel a running installation with a fixed error. @returns Nothing. */
    function cancel(): void {
      kill()
      finish(new Error('Installation was cancelled.'))
    }
    const timer = setTimeout(() => {
      kill()
      finish(new Error('Facet installation timed out.'))
    }, timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    child.once('error', () =>
      finish(new Error('The Facet CLI could not start.')),
    )
    child.once('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              'Facet installation failed. Check your adapter with facet adapter list, then retry.',
            ),
      ),
    )
    if (signal?.aborted) cancel()
  })
}

/** Install a trusted package through the real CLI. @param source Validated catalogue directory. @param project Fixed consuming project. @param signal Caller cancellation. @returns Successful CLI completion. */
export async function installLocalFacet(
  source: string,
  project: string,
  signal?: AbortSignal,
): Promise<void> {
  const destination = localSourcePath(source, project)
  await stageSource(source, destination, signal)
  await runFacetInstall(cliPath(), destination, project, signal)
}
