import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import { type } from 'arktype'
import { resolve } from 'node:path'
import { createCliSetup } from '../../../mcp/src/cli-setup'
import { emptyPlan, parsePlan } from './model'
import { installFacet } from './install'

const uri = 'ui://meeting-to-action/view.html'
const setup = createCliSetup()
let plan = emptyPlan
let installing: Promise<{ project: string; server: string }> | undefined
const assets = import.meta.dir
const project = resolve(
  process.env.FACET_EXAMPLE_PROJECT ?? './meeting-to-action-project',
)
const RequestSchema = type({
  name: "'meeting_open' | 'meeting_plan' | 'facet_setup' | 'facet_install'",
  'arguments?': 'object',
})
const SetupSchema = type({
  action: "'status' | 'install' | 'login' | 'cancel'",
})
const PlanInput = z.object({
  title: z.string().max(200),
  notes: z.string().max(30000),
  decisions: z.string().max(10000),
  actions: z
    .array(
      z.object({
        id: z.string().max(80),
        task: z.string().max(2000),
        owner: z.string().max(200),
        due: z.string().max(10),
        done: z.boolean(),
      }),
    )
    .max(100),
  source: z.enum(['empty', 'sample', 'host', 'edited']),
  edited: z.boolean().optional(),
})

/** Dispatch fixed capabilities across both transports. @param name Known tool name. @param args Untrusted input. @returns Validated state or setup response. */
export async function dispatch(
  name: string,
  args: unknown = {},
): Promise<Record<string, unknown>> {
  if (name === 'meeting_open') return { plan }
  if (name === 'meeting_plan') {
    const result = type({ plan: 'unknown' })(args)
    if (result instanceof type.errors) throw new Error('Provide a plan.')
    plan = parsePlan(result.plan)
    return { plan }
  }
  if (name === 'facet_setup') {
    const result = SetupSchema(args)
    if (result instanceof type.errors)
      throw new Error('Choose a valid setup action.')
    return { setup: await setup[result.action]() }
  }
  if (name === 'facet_install') {
    installing ??= installFacet(assets, project).finally(() => {
      installing = undefined
    })
    return { installation: await installing }
  }
  throw new Error('Unknown tool.')
}

const server = new McpServer({ name: 'meeting-to-action', version: '0.1.1' })
const tools: {
  name: string
  description: string
  inputSchema: Record<string, z.ZodType>
}[] = [
  {
    name: 'meeting_open',
    description: 'Open the Meeting to Action worksheet.',
    inputSchema: {},
  },
  {
    name: 'meeting_plan',
    description:
      'Provide or save a complete meeting action plan. Host assistants reason from notes and set source to host. Unknown owners and dates stay empty.',
    inputSchema: { plan: PlanInput },
  },
  {
    name: 'facet_setup',
    description:
      'Inspect CLI setup or explicitly install, sign in, or cancel sign in. The Facet CLI owns OAuth.',
    inputSchema: { action: z.enum(['status', 'install', 'login', 'cancel']) },
  },
  {
    name: 'facet_install',
    description:
      'Install the bundled Meeting to Action facet into the fixed local example project.',
    inputSchema: {},
  },
]
for (const tool of tools) {
  registerAppTool(
    server,
    tool.name,
    { ...tool, _meta: { ui: { resourceUri: uri } } },
    async (args) => {
      try {
        const result = await dispatch(tool.name, args)
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
              text: error instanceof Error ? error.message : 'Request failed.',
            },
          ],
        }
      }
    },
  )
}
registerAppResource(server, 'Meeting worksheet', uri, {}, async () => ({
  contents: [
    {
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await Bun.file(resolve(assets, 'view.html')).text(),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    },
  ],
}))

/** Serve only local same-origin requests. @param request Incoming HTTP request. @returns App or tool response. */
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  if (
    url.hostname !== '127.0.0.1' ||
    (origin && origin !== url.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return new Response('Forbidden', { status: 403 })
  if (request.method === 'GET' && url.pathname === '/')
    return new Response(Bun.file(resolve(assets, 'view.html')), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  if (request.method !== 'POST' || url.pathname !== '/api/tool')
    return new Response('Not found', { status: 404 })
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return new Response('JSON required', { status: 415 })
  if (Number(request.headers.get('content-length') ?? 0) > 250000)
    return new Response('Too large', { status: 413 })
  try {
    const text = await request.text()
    if (text.length > 250000) return new Response('Too large', { status: 413 })
    const parsed = RequestSchema(JSON.parse(text))
    if (parsed instanceof type.errors)
      return new Response('Invalid request', { status: 400 })
    return Response.json(await dispatch(parsed.name, parsed.arguments))
  } catch {
    return Response.json(
      { error: 'The request failed. Check setup and retry.' },
      { status: 400 },
    )
  }
}

if (import.meta.main) {
  if (process.argv.includes('--browser')) {
    const http = Bun.serve({
      hostname: '127.0.0.1',
      port: Number(process.env.PORT ?? 4318),
      maxRequestBodySize: 250000,
      fetch: handleRequest,
    })
    console.error(`Meeting to Action: ${http.url}`)
  } else await server.connect(new StdioServerTransport())
}
