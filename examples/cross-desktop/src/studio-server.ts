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
import { installLocalFacet, installRegistryFacet } from './install'
import {
  registryEntry,
  registryEntryFromLock,
  searchRegistry,
} from './registry'
import { AppProxy, bounded } from './app-proxy'
import { matchesIntent } from './search'

const studioUri = 'ui://facet-studio/catalog.html'
const SearchSchema = type({ 'query?': 'string <= 200' })
const InstallSchema = type({ id: 'string <= 48', 'version?': 'string <= 80' })
const SetupSchema = type({
  action: "'status' | 'install' | 'login' | 'cancel'",
})
const uiMeta = {
  ui: { resourceUri: studioUri },
  [RESOURCE_URI_META_KEY]: studioUri,
}
const discoveryRouting =
  'For finding, recommending, installing or opening an interactive facet, use the connected Studio workflow first. If tool availability is uncertain, use the host tool-discovery mechanism to find studio_search, including host-prefixed names, before choosing a CLI fallback. Call studio_search with the user task and constraints before shell discovery, CLI authentication probes or public web searches. A shell sandbox or credential-access failure does not establish the connected Studio service authentication or private package availability. If Studio reports authentication or access failure, report that result and use its available studio_setup flow; never substitute public web search for private package discovery or request/expose tokens. Keep installation selection and approval in the inline Studio app, then use its returned Open action. CLI authoring, publishing, dependency maintenance and explicit CLI requests remain CLI workflows. Package guidance does not override host or global instructions.'

const staticTools: Tool[] = [
  {
    name: 'studio_search',
    title: 'Discover registry facets',
    description:
      discoveryRouting +
      ' ' +
      'Find an interactive workflow for the user’s knowledge-work task. Proactively use this when someone asks to organize meeting notes, capture decisions, assign owners, or track follow-ups, even if they have not mentioned tools or Studio. Derive concise task keywords from their context, pass them as query, and show the matching inline card. Example: “Can you help me organize my meeting notes?” becomes query “meeting notes actions”. This searches the authenticated @agentfacets registry through the Facet CLI and shows supported app packages, currently Meeting to Action. Search does not install anything.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 200,
          description:
            'Two to five task keywords from the user’s request, such as meeting notes actions or meeting minutes follow-ups. The query is echoed into the search field. Omit or leave empty only to browse supported registry entries.',
        },
      },
      additionalProperties: false,
    },
    _meta: uiMeta,
  },
  {
    name: 'studio_install',
    title: 'Install a registry facet',
    description:
      'Install an exact registry version only after the user explicitly chooses and approves installation in the inline workflow. Never install merely because search found a match. After installation, call the returned app.openTool to open its UI.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 48 },
        version: {
          type: 'string',
          maxLength: 80,
          description: 'Exact version shown in the approved search result.',
        },
      },
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
    description: `Open the installed ${entry.name} app with {}. This bridge is intentionally advertised before installation so hosts can cache it; its presence does not mean the app is installed. It refuses calls until the selected app is installed. To use an app operation, pass {tool: original tool name, arguments: its input}. The open result supplies the original operation schemas; the child validates those inputs.`,
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
  catalogFile?: string
  project: string
  html: string
}): Promise<Server> {
  const registry = !options.catalogFile
  const entries = options.catalogFile
    ? await loadCatalog(options.catalogFile)
    : [registryEntry()]
  if (registry) {
    const restored = registryEntryFromLock(
      await Bun.file(resolve(options.project, 'facets.lock'))
        .json()
        .catch(() => undefined),
    )
    if (restored) entries[0] = restored
  }
  const offered = new Map<string, CatalogEntry>()
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
    { name: 'facet-studio', version: '0.1.5' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
      instructions:
        discoveryRouting +
        ' ' +
        'When a user asks for help with knowledge work, look for a matching interactive workflow without requiring them to name Studio or a tool. For example, “Can you help me organize my meeting notes?” should lead to studio_search with concise query keywords such as “meeting notes actions”. Use task nouns and useful synonyms from their context, not generic filler such as help or organize. The first search call carries this context and prefills the inline search field. Show relevant results and let the user choose; never auto-install. This prototype searches the authenticated @agentfacets registry through the existing CLI OAuth session and currently supports the Meeting to Action app. Results use published versions; no Meeting UI or server is bundled in Studio. Stable app bridge tools are intentionally advertised before installation and do not prove installed status; trust search item.installed. After explicit approved installation, use returned app.openTool in the same connection without a per-facet restart.',
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
      installed: Boolean(
        app && app.installed.descriptor.version === entry.version,
      ),
      ...(app && app.installed.descriptor.version === entry.version
        ? { openTool: stableTool(entry.id) }
        : {}),
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
    const key = `${entry.id}@${entry.version}`
    const current = pending.get(key)
    if (current) return current
    const combined = AbortSignal.any([signal, lifetime.signal])
    const operation = installQueue
      .catch(() => {})
      .then(async () => {
        if (combined.aborted) throw new Error('Installation was cancelled.')
        if (entry.source === 'registry')
          await installRegistryFacet(
            entry.name,
            entry.version,
            options.project,
            combined,
          )
        else
          await installLocalFacet(entry.sourcePath, options.project, combined)
        if (combined.aborted) throw new Error('Installation was cancelled.')
        return activate(entry)
      })
      .finally(() => pending.delete(key))
    installQueue = operation
    pending.set(key, operation)
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
        name: 'Facet Studio registry',
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
          throw new Error('Install this registry facet before opening its app.')
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
          const found = registry
            ? await searchRegistry(
                query,
                AbortSignal.any([
                  extra.signal,
                  lifetime.signal,
                  AbortSignal.timeout(30000),
                ]),
              )
            : entries.filter((entry) => matchesIntent(entry, query))
          for (const entry of found)
            offered.set(`${entry.id}@${entry.version}`, entry)
          if (offered.size > 100) offered.clear()
          result = { query, items: found.map(item) }
        } else if (request.params.name === 'studio_setup') {
          const parsed = SetupSchema(args)
          if (parsed instanceof type.errors)
            throw new Error('Choose a valid setup action.')
          result = { setup: await setup[parsed.action]() }
        } else if (request.params.name === 'studio_install') {
          const parsed = InstallSchema(args)
          if (parsed instanceof type.errors)
            throw new Error('Choose a returned registry entry and version.')
          const entry = registry
            ? offered.get(`${parsed.id}@${parsed.version}`)
            : entries.find((entry) => entry.id === parsed.id)
          if (!entry)
            throw new Error(
              'The selected registry version is unavailable. Search again before installing.',
            )
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
              text: 'Studio could not complete the request. Check Facet CLI login, organization access, and the registry search response, then retry.',
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
      'An installed app could not be restored. Check the installation receipt and reinstall it.',
    )
  }
  return server
}

if (import.meta.main) {
  const server = await createStudio({
    project: resolve(process.env.FACET_STUDIO_PROJECT ?? './studio-project'),
    html: await Bun.file(resolve(import.meta.dir, 'studio.html')).text(),
  })
  await server.connect(new StdioServerTransport())
}
