import { mkdir, copyFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import manifest from '../facet/facet.json'
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
  await Bun.write(join(skillRoot, 'references', 'host-setup.md'), hostSetup)
  await copyFile(
    join(assets, 'server.js'),
    join(skillRoot, 'assets', 'server.js'),
  )
  await copyFile(
    join(assets, 'view.html'),
    join(skillRoot, 'assets', 'view.html'),
  )
  const child = Bun.spawn([cliPath(), 'add', source], {
    cwd: project,
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  const timer = setTimeout(() => child.kill(), 60000)
  let code: number
  try {
    code = await child.exited
  } finally {
    clearTimeout(timer)
  }
  if (code !== 0)
    throw new Error(
      'Facet installation failed. Check your adapter with facet adapter list, then retry.',
    )
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
