import { type } from 'arktype'
import { lstat, realpath, readdir } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { createHash } from 'node:crypto'
import { localSourcePath } from './install'

const Id = type('string').matching(/^[a-z][a-z0-9-]{0,47}$/)
const DescriptorSchema = type({
  schemaVersion: '1',
  id: Id,
  version: 'string <= 80',
  runtime: "'bun'",
  entrypoint: 'string <= 200',
  openTool: 'string <= 128',
})
const CatalogueSchema = type({
  entries: type({ id: Id, source: "'local'", path: 'string <= 500' })
    .array()
    .atMostLength(20),
})
const ManifestSchema = type({
  name: 'string <= 100',
  version: 'string <= 80',
  'description?': 'string <= 1000',
  skills: 'object',
})
const SkillSchema = type({ 'files?': 'string[]' })
export type AppDescriptor = typeof DescriptorSchema.infer
export type CatalogEntry = {
  id: string
  name: string
  description: string
  version: string
  source: 'local' | 'registry'
  sourcePath: string
  skillPath: string
  companions: string[]
  descriptor: AppDescriptor
}
export type InstalledApp = {
  descriptor: AppDescriptor
  root: string
  entrypoint: string
  fingerprint: string
}

/** Constrain companion paths to a relative directory. @param path Untrusted relative path. @returns Validated path. */
export function companionPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path
      .split('/')
      .some((part) => part === '..' || part === '.' || part === '') ||
    path.includes('\0')
  )
    throw new Error(
      'App companion paths must stay inside their skill directory.',
    )
  return path
}

/** Reject symlinks and directory escape before reading a companion. @param root Trusted root. @param path Relative companion. @returns Canonical regular file. */
async function regularFile(root: string, path: string): Promise<string> {
  const normalized = companionPath(path)
  let current = root
  for (const component of normalized.split('/')) {
    current = join(current, component)
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('App companions cannot be symbolic links.')
  }
  const actual = await realpath(current)
  const inside = relative(await realpath(root), actual)
  if (
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside) ||
    !(await lstat(actual)).isFile()
  )
    throw new Error('App companion is outside the installed skill.')
  if ((await lstat(actual)).size > 4 * 1024 * 1024)
    throw new Error('App companion exceeds the prototype size limit.')
  return actual
}

/** Parse the prototype companion contract without extending Facet's schema. @param value Descriptor JSON. @returns Validated Bun app descriptor. */
export function parseDescriptor(value: unknown): AppDescriptor {
  const descriptor = DescriptorSchema(value)
  if (descriptor instanceof type.errors)
    throw new Error('Invalid local app descriptor.')
  companionPath(descriptor.entrypoint)
  if (
    !descriptor.entrypoint.endsWith('.js') ||
    !/^[A-Za-z0-9_.-]+$/.test(descriptor.openTool)
  )
    throw new Error(
      'The app must name a Bun JavaScript entrypoint and a valid open tool.',
    )
  return descriptor
}

/** Read configured local sources, never browser-supplied paths. @param file Trusted catalogue configuration. @returns Validated local entries. */
export async function loadCatalog(file: string): Promise<CatalogEntry[]> {
  const config = CatalogueSchema(await Bun.file(file).json())
  if (config instanceof type.errors)
    throw new Error('Invalid local catalogue configuration.')
  const seen = new Set<string>()
  const appIds = new Set<string>()
  const entries: CatalogEntry[] = []
  for (const item of config.entries) {
    if (seen.has(item.id)) throw new Error('Catalogue IDs must be unique.')
    seen.add(item.id)
    const sourcePath = resolve(dirname(file), companionPath(item.path))
    const manifest = ManifestSchema(
      await Bun.file(await regularFile(sourcePath, 'facet.json')).json(),
    )
    if (manifest instanceof type.errors)
      throw new Error('Invalid local facet manifest.')
    for (const [skillName, metadata] of Object.entries(manifest.skills)) {
      companionPath(skillName)
      const skill = SkillSchema(metadata)
      if (skill instanceof type.errors || !skill.files?.includes('app.json'))
        continue
      const skillPath = resolve(sourcePath, 'skills', skillName)
      if ((await lstat(skillPath)).isSymbolicLink())
        throw new Error('Catalogue skills cannot be symbolic links.')
      const companions = ['SKILL.md', ...skill.files]
      for (const path of companions) await regularFile(skillPath, path)
      const descriptor = parseDescriptor(
        await Bun.file(await regularFile(skillPath, 'app.json')).json(),
      )
      if (!companions.includes(descriptor.entrypoint))
        throw new Error(
          'The app entrypoint must be a declared skill companion.',
        )
      if (appIds.has(descriptor.id))
        throw new Error('App IDs must be unique within the local catalogue.')
      appIds.add(descriptor.id)
      if (descriptor.version !== manifest.version)
        throw new Error('App and facet versions must match.')
      if (entries.some((entry) => entry.id === item.id))
        throw new Error('This prototype supports one app per catalogue entry.')
      entries.push({
        ...item,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        sourcePath,
        skillPath,
        companions,
        descriptor,
      })
    }
    if (!entries.some((entry) => entry.id === item.id))
      throw new Error('The local facet has no declared app descriptor.')
  }
  return entries
}

/** Hash bounded trusted files for installation verification. @param path Regular companion. @returns SHA-256. */
async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await Bun.file(path).bytes())
    .digest('hex')
}

/** Read authoritative CLI installation identity before searching materialized files. @param entry Trusted package. @param project Consuming project. @returns Installed skill name or no matching CLI installation. */
async function lockedSkill(
  entry: CatalogEntry,
  project: string,
): Promise<string | undefined> {
  const LockSchema = type({ facets: { '[string]': 'unknown' } })
  const FacetSchema = type({
    version: 'string',
    source: { kind: "'local'", path: 'string' },
    assets: type({
      type: 'string',
      name: 'string',
      scope: 'string',
      materialization: { kind: 'string', 'as?': 'string' },
      files: type({ path: 'string', integrity: 'string' }).array(),
    }).array(),
  })
  try {
    const lock = LockSchema(await Bun.file(join(project, 'facets.lock')).json())
    if (lock instanceof type.errors) return
    const facet = FacetSchema(lock.facets[entry.name])
    if (
      facet instanceof type.errors ||
      facet.version !== entry.version ||
      resolve(facet.source.path) !==
        resolve(localSourcePath(entry.sourcePath, project))
    )
      return
    const sourceSkill = basename(entry.skillPath)
    const asset = facet.assets.find(
      (asset) =>
        asset.type === 'skill' &&
        asset.scope === 'project' &&
        asset.name === sourceSkill,
    )
    if (!asset || !['authored', 'aliased'].includes(asset.materialization.kind))
      return
    for (const companion of entry.companions) {
      const file = asset.files.find(
        (file) => file.path === `skills/${sourceSkill}/${companion}`,
      )
      if (
        !file ||
        file.integrity !==
          `sha256:${await digest(await regularFile(entry.skillPath, companion))}`
      )
        return
    }
    const name =
      asset.materialization.kind === 'aliased'
        ? asset.materialization.as
        : sourceSkill
    if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) return
    return name
  } catch {
    return
  }
}

/** Inspect only direct project or adapter skill roots, never nested package assets. @param project Consuming project. @param name CLI-recorded materialized skill name. @returns Non-symlink skill candidates. */
async function installedRoots(
  project: string,
  name: string,
): Promise<string[]> {
  const roots = [join(project, 'skills')]
  for (const child of await readdir(project, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (
      child.isDirectory() &&
      child.name.startsWith('.') &&
      !['.catalog', '.git'].includes(child.name)
    )
      roots.push(join(project, child.name, 'skills'))
  }
  const result: string[] = []
  for (const root of roots.slice(0, 40)) {
    const path = join(root, name)
    try {
      if (
        (await lstat(root)).isSymbolicLink() ||
        (await lstat(dirname(root))).isSymbolicLink() ||
        (await lstat(path)).isSymbolicLink()
      )
        continue
      if ((await lstat(path)).isDirectory()) result.push(path)
    } catch {
      /* Adapters need not all be configured in this project. */
    }
  }
  return result
}

/** Verify installed bytes against the configured package before execution. @param entry Trusted catalogue entry. @param project Fixed consuming project. @returns Verified portable app or no installation. */
export async function findInstalledApp(
  entry: CatalogEntry,
  project: string,
): Promise<InstalledApp | undefined> {
  if (entry.source === 'registry') return findRegistryApp(entry, project)
  const skillName = await lockedSkill(entry, project)
  if (!skillName) return
  for (const root of await installedRoots(project, skillName)) {
    try {
      const descriptor = parseDescriptor(
        await Bun.file(await regularFile(root, 'app.json')).json(),
      )
      if (
        descriptor.id !== entry.descriptor.id ||
        descriptor.version !== entry.version
      )
        continue
      const hashes: string[] = []
      for (const companion of entry.companions.filter(
        (path) => path !== 'SKILL.md',
      )) {
        const expected = await digest(
          await regularFile(entry.skillPath, companion),
        )
        if ((await digest(await regularFile(root, companion))) !== expected)
          throw new Error('Installed app differs from its catalogue package.')
        hashes.push(expected)
      }
      return {
        descriptor,
        root,
        entrypoint: await regularFile(root, descriptor.entrypoint),
        fingerprint: createHash('sha256')
          .update(hashes.join(':'))
          .digest('hex'),
      }
    } catch {
      /* Unrelated or changed materialized assets cannot become executable apps. */
    }
  }
}

/** Verify registry provenance and every materialized skill file against CLI integrity receipts. @param entry Approved registry version and app identity. @param project Consuming project. @returns Verified installed child or no matching installation. */
async function findRegistryApp(
  entry: CatalogEntry,
  project: string,
): Promise<InstalledApp | undefined> {
  const Receipt = type({
    integrity: /^sha256:[a-f0-9]{64}$/,
    version: 'string',
    source: { kind: "'registry'", registry: 'string' },
    assets: type({
      type: 'string',
      name: 'string',
      scope: 'string',
      materialization: { kind: 'string', 'as?': 'string' },
      files: type({ path: 'string', integrity: 'string' })
        .array()
        .atMostLength(300),
    }).array(),
  })
  try {
    const lock = type({
      lockfileVersion: 'number',
      facets: { '[string]': 'unknown' },
    }).assert(await Bun.file(join(project, 'facets.lock')).json())
    if (lock.lockfileVersion !== 0.3) return
    const receipt = Receipt.assert(lock.facets[entry.name])
    if (
      receipt.version !== entry.version ||
      receipt.source.registry !== 'https://api.agentfacets.io'
    )
      return
    const asset = receipt.assets.find(
      (asset) =>
        asset.type === 'skill' &&
        asset.scope === 'project' &&
        asset.name === entry.descriptor.id,
    )
    if (!asset || !['authored', 'aliased'].includes(asset.materialization.kind))
      return
    const name =
      asset.materialization.kind === 'aliased'
        ? asset.materialization.as
        : asset.name
    if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) return
    const prefix = `skills/${asset.name}/`
    if (
      !asset.files.length ||
      new Set(asset.files.map((file) => file.path)).size !== asset.files.length
    )
      return
    for (const root of await installedRoots(project, name)) {
      try {
        const hashes: string[] = []
        for (const file of asset.files) {
          if (
            !file.path.startsWith(prefix) ||
            !/^sha256:[a-f0-9]{64}$/.test(file.integrity)
          )
            throw new Error('Invalid receipt.')
          const installedFile = await regularFile(
            root,
            file.path.slice(prefix.length),
          )
          // Adapters transform the skill primary; executable and UI companions retain canonical bytes.
          if (file.path === prefix + 'SKILL.md') continue
          const actual = `sha256:${await digest(installedFile)}`
          if (actual !== file.integrity)
            throw new Error('Installed bytes differ from receipt.')
          hashes.push(`${file.path}:${actual}`)
        }
        const descriptor = parseDescriptor(
          await Bun.file(await regularFile(root, 'app.json')).json(),
        )
        if (
          descriptor.id !== entry.descriptor.id ||
          descriptor.version !== entry.version ||
          descriptor.openTool !== entry.descriptor.openTool
        )
          continue
        for (const path of [
          'app.json',
          'SKILL.md',
          descriptor.entrypoint,
          'assets/view.html',
        ]) {
          if (!asset.files.some((file) => file.path === prefix + path))
            throw new Error('Missing companion receipt.')
        }
        return {
          descriptor,
          root,
          entrypoint: await regularFile(root, descriptor.entrypoint),
          fingerprint: createHash('sha256')
            .update(hashes.join(':'))
            .digest('hex'),
        }
      } catch {
        /* A changed adapter copy is never executable. */
      }
    }
  } catch {
    /* Missing or invalid CLI receipts do not establish installation. */
  }
}
