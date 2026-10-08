import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CallToolResultSchema,
  type Tool,
  type Resource,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import { RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server'
import { createHash } from 'node:crypto'
import type { InstalledApp } from './catalog'

/** Name app capabilities without collisions or tool-length overflow. @param id Validated app ID. @param name Original child tool. @returns Stable host tool name under 64 characters. */
export function toolAlias(id: string, name: string): string {
  const hash = createHash('sha256')
    .update(`${id}\0${name}`)
    .digest('hex')
    .slice(0, 12)
  return `app_${id.slice(0, 16)}_${hash}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 25)}`
}

/** Scope a resource to one verified installed app. @param id App ID. @param uri Original child resource. @returns Namespaced resource URI. */
function resourceAlias(id: string, uri: string): string {
  return `ui://facet-studio/apps/${id}/${encodeURIComponent(uri)}`
}

/** Restrict child response size before returning data to the host. @param value Protocol response. @returns The bounded response. */
export function bounded<T>(value: T): T {
  if (JSON.stringify(value).length > 4 * 1024 * 1024)
    throw new Error('The app response exceeds the prototype size limit.')
  return value
}

/** Rewrite metadata while preserving child rendering hints. @param metadata Child metadata. @param resources Known resource mapping. @returns Host-facing metadata. */
function appMetadata(
  metadata: Record<string, unknown> | undefined,
  resources: Record<string, string>,
): Record<string, unknown> {
  const ui = metadata?.ui
  const source =
    ui && typeof ui === 'object' && !Array.isArray(ui)
      ? (ui as Record<string, unknown>)
      : {}
  const original =
    typeof source.resourceUri === 'string'
      ? source.resourceUri
      : metadata?.[RESOURCE_URI_META_KEY]
  if (typeof original !== 'string') return { ...metadata }
  const uri = resources[original]
  if (!uri) throw new Error('App tool references an undeclared resource.')
  return {
    ...metadata,
    ui: { ...source, resourceUri: uri },
    [RESOURCE_URI_META_KEY]: uri,
  }
}

/** Proxy the capabilities of one byte-verified local app without changing their JSON schemas. */
export class AppProxy {
  readonly originalTools: Tool[]
  readonly tools: Tool[]
  readonly resources: Resource[]
  readonly toolNames: Record<string, string>
  readonly openTool: string
  private closed = false

  /** Retain validated child capabilities. @param client Connected child. @param installed Verified package. @param tools Child tools. @param resources Child resources. @returns Proxy instance. */
  private constructor(
    private client: Client,
    readonly installed: InstalledApp,
    tools: Tool[],
    resources: Resource[],
  ) {
    this.originalTools = tools
    if (
      JSON.stringify(
        tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      ).length >
      128 * 1024
    )
      throw new Error('App operation schemas exceed the bridge limit.')
    this.toolNames = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        toolAlias(installed.descriptor.id, tool.name),
      ]),
    )
    this.openTool = this.toolNames[installed.descriptor.openTool]!
    const resourceNames = Object.fromEntries(
      resources.map((resource) => [
        resource.uri,
        resourceAlias(installed.descriptor.id, resource.uri),
      ]),
    )
    this.tools = tools.map((tool) => ({
      ...tool,
      name: this.toolNames[tool.name]!,
      _meta: appMetadata(tool._meta, resourceNames),
      description: `${tool.description ?? tool.name} Installed app tool mapping: ${JSON.stringify(this.toolNames)}`,
    }))
    this.resources = resources.map((resource) => ({
      ...resource,
      uri: resourceNames[resource.uri]!,
    }))
  }

  /** Start only an entrypoint already verified against the catalogue. @param installed Verified installation. @param disconnected Unexpected child-close observer. @returns Connected proxy. */
  static async start(
    installed: InstalledApp,
    disconnected: () => void,
  ): Promise<AppProxy> {
    const client = new Client({
      name: 'facet-studio-app-proxy',
      version: '0.1.2',
    })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [installed.entrypoint],
      cwd: installed.root,
      stderr: 'ignore',
    })
    try {
      await client.connect(transport, { timeout: 10000 })
      const tools = await client.listTools(undefined, { timeout: 10000 })
      const resources = await client.listResources(undefined, {
        timeout: 10000,
      })
      if (
        tools.nextCursor ||
        resources.nextCursor ||
        tools.tools.length > 40 ||
        resources.resources.length > 40
      )
        throw new Error('The app exceeds the prototype capability limit.')
      if (
        !tools.tools.some((tool) => tool.name === installed.descriptor.openTool)
      )
        throw new Error('The app open tool is missing.')
      if (
        new Set(tools.tools.map((tool) => tool.name)).size !==
        tools.tools.length
      )
        throw new Error('App tool names must be unique.')
      const proxy = new AppProxy(
        client,
        installed,
        tools.tools,
        resources.resources,
      )
      client.onclose = () => {
        if (!proxy.closed) disconnected()
      }
      return proxy
    } catch {
      await client.close()
      throw new Error(
        'The installed app could not start. Reinstall it and try again.',
      )
    }
  }

  /** Forward a namespaced call to the child that owns it. @param name Public tool name. @param args User input validated by the child. @param signal Request cancellation. @returns Child result plus app routing metadata. */
  async call(
    name: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const original = Object.entries(this.toolNames).find(
      ([, alias]) => alias === name,
    )?.[0]
    if (!original) throw new Error('Unknown installed app tool.')
    try {
      const result = await this.client.callTool(
        { name: original, arguments: args },
        undefined,
        { timeout: 30000, signal },
      )
      return CallToolResultSchema.parse(
        bounded({
          ...result,
          _meta: { ...result._meta, facetToolNames: this.toolNames },
        }),
      )
    } catch {
      await this.client.close()
      throw new Error(
        'The installed app stopped responding. Reinstall it and retry.',
      )
    }
  }

  /** Read a namespaced child resource. @param uri Public resource URI. @param signal Request cancellation. @returns Resource with host-facing URIs. */
  async read(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const prefix = `ui://facet-studio/apps/${this.installed.descriptor.id}/`
    if (!this.resources.some((resource) => resource.uri === uri))
      throw new Error('Unknown installed app resource.')
    const original = decodeURIComponent(uri.slice(prefix.length))
    const result = await this.client.readResource(
      { uri: original },
      { timeout: 10000, signal },
    )
    return bounded({
      ...result,
      contents: result.contents.map((content) => ({
        ...content,
        uri: resourceAlias(this.installed.descriptor.id, content.uri),
      })),
    })
  }

  /** Terminate the owned child transport. @returns Cleanup completion. */
  async close(): Promise<void> {
    this.closed = true
    await this.client.close()
  }
}
