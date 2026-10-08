import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { installFacet } from '../src/install'

const root = resolve(import.meta.dir, '..')
const cli = Bun.which('facet')
if (!cli) throw new Error('Install the Facet CLI before running this check.')
// Keep the caller's adapter configuration; an empty FACET_DIR would hide installed adapters.
const adapters = Bun.spawnSync([cli, 'adapter', 'list'], {
  stdout: 'pipe',
  stderr: 'pipe',
})
if (adapters.exitCode !== 0)
  throw new Error('Unable to inspect installed Facet adapters.')
console.log(new TextDecoder().decode(adapters.stdout).trim())
const project = await mkdtemp(join(tmpdir(), 'meeting-facet-install-'))
const first = await installFacet(join(root, 'dist'), project)
console.log(`Fresh installation: ${JSON.stringify(first)}`)
for (const file of ['server.js', 'view.html']) {
  const built = createHash('sha256')
    .update(await Bun.file(join(root, 'dist', file)).bytes())
    .digest('hex')
  const installed = createHash('sha256')
    .update(await Bun.file(join(dirname(first.server), file)).bytes())
    .digest('hex')
  if (built !== installed)
    throw new Error(`Installed ${file} differs from the built companion.`)
}
const second = await installFacet(join(root, 'dist'), project)
if (first.server !== second.server)
  throw new Error('Repeated install changed the companion location.')
const smoke = Bun.spawn(
  [process.execPath, join(root, 'scripts', 'smoke.ts'), first.server],
  { cwd: project, stdout: 'inherit', stderr: 'inherit' },
)
if ((await smoke.exited) !== 0)
  throw new Error('Installed server failed the protocol check.')
console.log(
  'PASS: fresh real-CLI installation, matching companion hashes, repeated installation, and installed-server protocol smoke.',
)
