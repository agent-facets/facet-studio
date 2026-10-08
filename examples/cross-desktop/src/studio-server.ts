import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from '@modelcontextprotocol/ext-apps/server'
import { type } from 'arktype'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createCliSetup } from '../../../mcp/src/cli-setup'
import { loadCatalog, findInstalledApp, type CatalogEntry } from './catalog'
import { installLocalFacet } from './install'
import { AppProxy, bounded } from './app-proxy'

const studioUri = 'ui://facet-studio/catalog.html'
const SearchSchema = type({ 'query?': 'string <= 200' })
const InstallSchema = type({ id: 'string <= 48' })
const SetupSchema = type({
  action: "'status' | 'install' | 'login' | 'cancel'",
})
const uiMeta = {
  ui: { resourceUri: studioUri },
  [RESOURCE_URI_META_KEY]: studioUri,
}
const staticTools: Tool[] = [
  {
    name: 'studio_search',
    title: 'Discover local facets',
    description:
      'Search the explicitly configured local prototype catalogue and show Facet Studio. This does not search the public registry.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200 } },
      additionalProperties: false,
    },
    _meta: uiMeta,
  },
  {
    name: 'studio_install',
    title: 'Install a local facet',
    description:
      'Install the selected configured local facet through the Facet CLI and expose its verified app tools in this connection. After installation, call the returned app.openTool to open its UI.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 48 } },
      required: ['id'],
      additionalProperties: false,
    },
    _meta: uiMeta,
  },
  {
    name: 'studio_setup',
    title: 'Set up Facet',
    description:
      'Inspect the Facet CLI or explicitly install it, sign in with its device flow, or cancel login.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'install', 'login', 'cancel'],
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    _meta: uiMeta,
  },
]

/** Name a predeclared bridge independently of child capabilities. @param id Catalogue identity. @returns Stable host tool name. */
export function stableTool(id: string): string {
  return `studio_app_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
}

/** Bind an installed app's primary view without mutable selection state. @param id Catalogue identity. @returns Stable resource URI. */
export function stableResource(id: string): string {
  return `ui://facet-studio/installed/${id}.html`
}

const BridgeInput = type({
  'tool?': 'string <= 128',
  'arguments?': 'object',
  '+': 'reject',
})

/** Declare a cache-compatible wrapper without starting uninstalled code. @param entry Trusted catalogue metadata. @returns Static wrapper definition. */
function bridgeTool(entry: CatalogEntry): Tool {
  const uri = stableResource(entry.id)
  return {
    name: stableTool(entry.id),
    title: `Open ${entry.name}`,
    description: `Open the installed ${entry.name} app with {}. Only works after installation. To use an app operation, pass {tool: original tool name, arguments: its input}. The open result supplies the original operation schemas; the child validates those inputs.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', maxLength: 128 },
        arguments: { type: 'object' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { resourceUri: uri }, [RESOURCE_URI_META_KEY]: uri },
  }
}

/** Construct one connected Studio with a fixed catalogue and consuming project. @param options Trusted process configuration. @returns Raw MCP server with namespaced child capabilities. */
export async function createStudio(options: {
  catalogFile: string
  project: string
  html: string
}): Promise<Server> {
  const entries = await loadCatalog(options.catalogFile)
  const bridgeTools = entries.map(bridgeTool)
  if (
    new Set([...staticTools, ...bridgeTools].map((tool) => tool.name)).size !==
    staticTools.length + bridgeTools.length
  )
    throw new Error('Catalogue bridge tool names collide.')
  const setup = createCliSetup()
  const apps = new Map<string, AppProxy>()
  const pending = new Map<string, Promise<AppProxy>>()
  const server = new Server(
    { name: 'facet-studio-local', version: '0.1.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
      instructions:
        'Facet Studio searches an explicitly local prototype catalogue. Install a catalogue id, then call the returned app.openTool. Installation publishes namespaced tools in this same connection; no per-facet host configuration is needed.',
    },
  )
  let closing = false
  const lifetime = new AbortController()
  let installQueue: Promise<unknown> = Promise.resolve()

  /** Publish capability changes after installation or child exit. @returns Notification completion. */
  async function changed(): Promise<void> {
    if (closing || !server.transport) return
    await Promise.all([
      server.sendToolListChanged(),
      server.sendResourceListChanged(),
    ])
  }

  /** Expose display metadata without filesystem paths. @param entry Catalogue source. @returns UI-facing item. */
  function item(entry: CatalogEntry) {
    const app = apps.get(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      source: entry.source,
      installed: Boolean(app),
      ...(app ? { openTool: stableTool(entry.id) } : {}),
    }
  }

  /** Attach a verified app to this connection. @param entry Configured source. @returns Connected proxy. */
  async function activate(entry: CatalogEntry): Promise<AppProxy> {
    const installed = await findInstalledApp(entry, options.project)
    if (!installed)
      throw new Error(
        'Installed app companions could not be verified. Reinstall the facet.',
      )
    const existing = apps.get(entry.id)
    if (existing?.installed.fingerprint === installed.fingerprint)
      return existing
    if (
      [...apps.entries()].some(
        ([id, app]) =>
          id !== entry.id &&
          app.installed.descriptor.id === installed.descriptor.id,
      )
    )
      throw new Error('Another installed catalogue entry uses this app ID.')
    const app = await AppProxy.start(installed, () => {
      apps.delete(entry.id)
      void changed().catch(() => {})
    })
    const occupied = new Set(
      [
        ...staticTools,
        ...bridgeTools,
        ...[...apps.entries()]
          .filter(([id]) => id !== entry.id)
          .flatMap(([, child]) => child.tools),
      ].map((tool) => tool.name),
    )
    if (
      app.tools.some((tool) => occupied.has(tool.name)) ||
      new Set(app.tools.map((tool) => tool.name)).size !== app.tools.length
    ) {
      await app.close()
      throw new Error('Installed app tool aliases collide.')
    }
    if (closing) {
      await app.close()
      throw new Error('Studio is closing.')
    }
    if (existing) await existing.close()
    apps.set(entry.id, app)
    await changed()
    return app
  }

  /** Run explicit catalogue installation once per entry. @param entry Configured source. @param signal Caller cancellation. @returns Activated installed app. */
  async function install(
    entry: CatalogEntry,
    signal: AbortSignal,
  ): Promise<AppProxy> {
    const current = pending.get(entry.id)
    if (current) return current
    const combined = AbortSignal.any([signal, lifetime.signal])
    const operation = installQueue
      .catch(() => {})
      .then(async () => {
        if (combined.aborted) throw new Error('Installation was cancelled.')
        await installLocalFacet(entry.sourcePath, options.project, combined)
        if (combined.aborted) throw new Error('Installation was cancelled.')
        return activate(entry)
      })
      .finally(() => pending.delete(entry.id))
    installQueue = operation
    pending.set(entry.id, operation)
    return operation
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...staticTools,
      ...bridgeTools,
      ...[...apps.values()].flatMap((app) => app.tools),
    ],
  }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: studioUri,
        name: 'Facet Studio local catalogue',
        mimeType: RESOURCE_MIME_TYPE,
      },
      ...entries.map((entry) => ({
        uri: stableResource(entry.id),
        name: entry.name,
        mimeType: RESOURCE_MIME_TYPE,
      })),
      ...[...apps.values()].flatMap((app) => app.resources),
    ],
  }))
  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request, extra) => {
      if (request.params.uri === studioUri)
        return {
          contents: [
            {
              uri: studioUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: options.html,
              _meta: {
                ui: { csp: { connectDomains: [], resourceDomains: [] } },
              },
            },
          ],
        }
      const entry = entries.find(
        (entry) => stableResource(entry.id) === request.params.uri,
      )
      if (entry) {
        const installed = apps.get(entry.id)
        if (!installed)
          throw new Error('Install this local facet before opening its app.')
        const open = installed.tools.find(
          (tool) => tool.name === installed.openTool,
        )
        const uri = open?._meta?.[RESOURCE_URI_META_KEY]
        if (typeof uri !== 'string')
          throw new Error('The installed app has no primary UI resource.')
        try {
          const response = await installed.read(uri, extra.signal)
          if (
            response.contents.length !== 1 ||
            !response.contents.every(
              (content) =>
                content.mimeType === RESOURCE_MIME_TYPE && 'text' in content,
            )
          )
            throw new Error('Unsupported primary UI resource.')
          return {
            ...response,
            contents: response.contents.map((content) => ({
              ...content,
              uri: request.params.uri,
            })),
          }
        } catch {
          throw new Error(
            'The installed primary UI is unavailable. Reinstall the facet and retry.',
          )
        }
      }
      const app = [...apps.values()].find((app) =>
        app.resources.some((resource) => resource.uri === request.params.uri),
      )
      if (!app) throw new Error('Unknown installed app resource.')
      try {
        return await app.read(request.params.uri, extra.signal)
      } catch {
        throw new Error(
          'The installed app resource is unavailable. Reinstall the facet and retry.',
        )
      }
    },
  )
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      try {
        const args = request.params.arguments ?? {}
        let result: Record<string, unknown>
        const bridgedEntry = entries.find(
          (entry) => stableTool(entry.id) === request.params.name,
        )
        if (bridgedEntry) {
          const parsed = BridgeInput(args)
          if (
            parsed instanceof type.errors ||
            (parsed.arguments !== undefined &&
              (Array.isArray(parsed.arguments) || parsed.arguments === null))
          )
            throw new Error('Invalid app operation envelope.')
          const app = apps.get(bridgedEntry.id)
          if (!app) throw new Error('Install this facet before opening it.')
          const original = parsed.tool ?? app.installed.descriptor.openTool
          const alias = Object.hasOwn(app.toolNames, original)
            ? app.toolNames[original]
            : undefined
          if (!alias) throw new Error('Unknown app operation.')
          const tools = app.originalTools.map(
            ({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            }),
          )
          const schemaText = JSON.stringify(tools)
          if (schemaText.length > 128 * 1024)
            throw new Error('App operation schemas exceed the bridge limit.')
          const result = await app.call(
            alias,
            (parsed.arguments ?? {}) as Record<string, unknown>,
            extra.signal,
          )
          return bounded({
            ...result,
            content: [
              ...result.content,
              {
                type: 'text',
                text: `Installed app operations. Call ${stableTool(bridgedEntry.id)} with {"tool":"original name","arguments":{...}}. Original schemas (validated by the child): ${schemaText}`,
              },
            ],
            _meta: {
              ...result._meta,
              facetBridge: {
                tool: stableTool(bridgedEntry.id),
                appId: app.installed.descriptor.id,
                tools,
              },
            },
          })
        }
        if (request.params.name === 'studio_search') {
          const parsed = SearchSchema(args)
          if (parsed instanceof type.errors)
            throw new Error('Enter a search of at most 200 characters.')
          const query = parsed.query ?? ''
          result = {
            query,
            items: entries
              .filter((entry) =>
                `${entry.name} ${entry.description}`
                  .toLowerCase()
                  .includes(query.trim().toLowerCase()),
              )
              .map(item),
          }
        } else if (request.params.name === 'studio_setup') {
          const parsed = SetupSchema(args)
          if (parsed instanceof type.errors)
            throw new Error('Choose a valid setup action.')
          result = { setup: await setup[parsed.action]() }
        } else if (request.params.name === 'studio_install') {
          const parsed = InstallSchema(args)
          if (parsed instanceof type.errors)
            throw new Error('Choose a local catalogue entry.')
          const entry = entries.find((entry) => entry.id === parsed.id)
          if (!entry)
            throw new Error('The selected local facet is unavailable.')
          const app = await install(entry, extra.signal)
          result = {
            item: item(entry),
            app: {
              id: app.installed.descriptor.id,
              openTool: stableTool(entry.id),
              toolNames: app.toolNames,
            },
          }
        } else {
          const app = [...apps.values()].find((app) =>
            app.tools.some((tool) => tool.name === request.params.name),
          )
          if (!app)
            throw new Error(
              'Unknown installed app tool. Search and install its facet first.',
            )
          return await app.call(
            request.params.name,
            request.params.arguments,
            extra.signal,
          )
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Studio could not complete the request. Check CLI setup and the selected local facet, then retry.',
            },
          ],
        }
      }
    },
  )
  /** Dispose children and pending work on disconnect or partial initialization failure. @returns Cleanup completion. */
  async function dispose(): Promise<void> {
    closing = true
    lifetime.abort()
    const children = [...apps.values()]
    apps.clear()
    await Promise.allSettled([
      setup.cancel(),
      ...children.map((app) => app.close()),
    ])
  }
  server.onclose = () => {
    void dispose()
  }
  try {
    for (const entry of entries) {
      if (await findInstalledApp(entry, options.project)) await activate(entry)
    }
  } catch {
    await dispose()
    throw new Error(
      'An installed app could not be restored. Check the local catalogue and reinstall it.',
    )
  }
  return server
}

if (import.meta.main) {
  const server = await createStudio({
    catalogFile: resolve(
      process.env.FACET_STUDIO_CATALOG ??
        resolve(import.meta.dir, 'catalog.json'),
    ),
    project: resolve(process.env.FACET_STUDIO_PROJECT ?? './studio-project'),
    html: await Bun.file(resolve(import.meta.dir, 'studio.html')).text(),
  })
  await server.connect(new StdioServerTransport())
}
