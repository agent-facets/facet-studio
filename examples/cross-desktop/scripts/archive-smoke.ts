import { resolve } from 'node:path'
import { type } from 'arktype'
import manifest from '../facet/facet.json'
import studioManifest from '../studio-facet/facet.json'

const modulePath = process.argv[2]
if (!modulePath)
  throw new Error(
    'Pass the Facet protocol module path to verify the built archives offline.',
  )
const imported: unknown = await import(resolve(modulePath))
const module = type({ validateFacetArchive: 'Function' })(imported)
if (module instanceof type.errors)
  throw new Error('The supplied module does not export validateFacetArchive.')
type GunzipResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'corrupt' }
const validate = module.validateFacetArchive as (
  bytes: Uint8Array,
  options: { gunzip: (bytes: Uint8Array) => Promise<GunzipResult> },
) => Promise<unknown>
const root = resolve(import.meta.dir, '..')
for (const [directory, metadata] of [
  ['facet', manifest],
  ['studio-facet', studioManifest],
] as const) {
  const path = resolve(
    root,
    directory,
    'dist',
    `${metadata.name}-${metadata.version}.facet`,
  )
  let expandedBytes = 0
  const result = await validate(await Bun.file(path).bytes(), {
    /** Decode an archive for integrity inspection without claiming registry size-policy compliance. @param bytes Gzip archive payload. @returns Decoded bytes or corruption failure. */
    async gunzip(bytes) {
      try {
        const decoded = Bun.gunzipSync(new Uint8Array(bytes))
        expandedBytes = decoded.length
        return { ok: true, bytes: decoded }
      } catch {
        return { ok: false, reason: 'corrupt' }
      }
    },
  })
  if (type({ ok: 'true', data: 'object' })(result) instanceof type.errors)
    throw new Error(`Archive verification failed: ${JSON.stringify(result)}`)
  console.log(
    JSON.stringify({ package: metadata.name, verified: true, expandedBytes }),
  )
}
