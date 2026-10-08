import { type } from 'arktype'
import { App } from '@modelcontextprotocol/ext-apps'
import type { MeetingAgent } from './agent'
import { parsePlan, type Plan } from './model'

const SetupSchema = type({
  cli: "'missing' | 'ready'",
  authentication: "'unknown' | 'signed-out' | 'authenticated'",
  operation:
    "'idle' | 'installing' | 'starting-login' | 'awaiting-login' | 'failed' | 'cancelled'",
  'verificationUrl?': 'string',
  'userCode?': 'string',
  'error?': 'string',
})
export type SetupStatus = typeof SetupSchema.infer

/** Validate CLI status at the UI boundary. @param value Server response. @returns Safe setup state. */
export function parseSetup(value: unknown): SetupStatus {
  const result = SetupSchema(value)
  if (result instanceof type.errors)
    throw new Error('Setup returned an invalid status. Reopen the worksheet.')
  if (
    result.verificationUrl &&
    new URL(result.verificationUrl).origin !== 'https://login.agentfacets.io'
  )
    throw new Error('Setup returned an unexpected authorization address.')
  return result
}
const FacetBridgeSchema = type({
  tool: 'string',
  appId: 'string',
  tools: type({
    name: 'string',
    'description?': 'string',
    inputSchema: 'object',
  }).array(),
})
export type FacetBridge = typeof FacetBridgeSchema.infer

/** Validate optional cache-compatible routing before using any tool. @param value Host metadata. @returns Validated routing. */
export function parseFacetBridge(value: unknown): FacetBridge {
  const result = FacetBridgeSchema(value)
  if (
    result instanceof type.errors ||
    !/^studio_app_[a-f0-9]{16}$/.test(result.tool) ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(result.appId) ||
    result.tools.length < 1 ||
    result.tools.length > 40 ||
    new Set(result.tools.map((tool) => tool.name)).size !==
      result.tools.length ||
    result.tools.some(
      (tool) =>
        !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
        Array.isArray(tool.inputSchema),
    ) ||
    JSON.stringify(result.tools).length > 128 * 1024
  )
    throw new Error('The installed app bridge metadata is invalid.')
  return result
}

export type Bridge = {
  connected: boolean
  installed: boolean
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  request: (plan: Plan) => Promise<void>
}

/** Check a response envelope. @param value Server data. @returns Object payload. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The server returned an invalid response.')
  return value as Record<string, unknown>
}

/** Connect one UI to its MCP host or browser harness. @param agent Shared state adapter. @param changed Connection observer. @returns Transport operations. */
export async function connectBridge(
  agent: MeetingAgent,
  changed: (bridge: Bridge) => void,
  failed: (message: string) => void,
  hostPlanReceived: () => void,
  createApp: () => App = () =>
    new App({ name: 'Meeting to Action', version: '0.1.1' }, {}),
): Promise<Bridge> {
  if (window.parent === window) {
    const bridge: Bridge = {
      connected: false,
      installed: false,
      async call(name, args = {}) {
        const response = await fetch('/api/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, arguments: args }),
        })
        if (!response.ok)
          throw new Error('The local server could not complete the request.')
        return record(await response.json())
      },
      async request() {
        throw new Error(
          'Host reasoning is unavailable in this browser. Open the facet in an MCP Apps host.',
        )
      },
    }
    changed(bridge)
    return bridge
  }
  let toolNames: Record<string, string> = {}
  let facetBridge: FacetBridge | undefined
  const app = createApp()
  const initial = Promise.withResolvers<void>()
  const initialTimer = setTimeout(
    () =>
      initial.reject(
        new Error(
          'The host did not deliver its initial tool result. Reopen the installed app.',
        ),
      ),
    15000,
  )
  app.ontoolresult = (result) => {
    if (result._meta?.facetBridge !== undefined) {
      try {
        facetBridge = parseFacetBridge(result._meta.facetBridge)
      } catch (error) {
        initial.reject(error)
        failed('The installed app routing is invalid. Reopen the app.')
        return
      }
    }
    const mapping = result._meta?.facetToolNames
    if (mapping !== undefined) {
      const parsed = type({ '[string]': 'string' })(mapping)
      if (
        parsed instanceof type.errors ||
        Object.values(parsed).some(
          (name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name),
        )
      ) {
        initial.reject(
          new Error(
            'The app tool routing is invalid. Reopen the installed app.',
          ),
        )
        return
      }
      toolNames = parsed
    }
    const payload = result.structuredContent
    const accepted = payload?.plan
      ? receiveHostPlan(agent, payload.plan, hostPlanReceived)
      : Promise.resolve()
    void accepted
      .then(() => initial.resolve())
      .catch(() => {
        const message =
          'The assistant returned an invalid plan. Ask it to correct the tool input.'
        failed(message)
        initial.reject(new Error(message))
      })
  }
  app.onhostcontextchanged = (context) => {
    if (context.theme) document.documentElement.dataset.theme = context.theme
  }
  try {
    await Promise.all([
      app.connect(undefined, { timeout: 10000 }),
      initial.promise,
    ])
  } catch (error) {
    await app.close()
    throw error
  } finally {
    clearTimeout(initialTimer)
  }
  const context = app.getHostContext()
  if (context?.theme) document.documentElement.dataset.theme = context.theme
  const bridge: Bridge = {
    connected: true,
    installed: Boolean(facetBridge),
    async call(name, args = {}) {
      if (facetBridge && !facetBridge.tools.some((tool) => tool.name === name))
        throw new Error('The installed app does not expose this operation.')
      const result = await app.callServerTool({
        name: facetBridge?.tool ?? toolNames[name] ?? name,
        arguments: facetBridge ? { tool: name, arguments: args } : args,
      })
      if (result.isError)
        throw new Error(
          'The host could not complete the request. Try again in the conversation.',
        )
      return record(result.structuredContent)
    },
    async request(plan) {
      const context = planModelContext(
        plan,
        toolNames.meeting_plan,
        facetBridge,
      )
      const supported = app.getHostCapabilities()?.updateModelContext
      try {
        if (supported?.text) {
          await app.updateModelContext(
            {
              content: [
                {
                  type: 'text',
                  text: context,
                  annotations: { audience: ['assistant'] },
                },
              ],
            },
            { timeout: 3000 },
          )
        } else if (supported?.structuredContent) {
          await app.updateModelContext(
            { structuredContent: { worksheetContext: context } },
            { timeout: 3000 },
          )
        }
      } catch {
        // Existing tool-result context preserves routing when optional context updates fail.
      }
      const result = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: planRequest(plan, Boolean(facetBridge)),
          },
        ],
      })
      if (result.isError)
        throw new Error(
          'The host declined the request. Ask for a meeting plan in the conversation.',
        )
    },
  }
  changed(bridge)
  return bridge
}

/** Preserve user-authored meeting identity in the host request. @param plan Current worksheet. @returns Assistant instruction and meeting content. */
export function planModelContext(
  plan: Plan,
  tool = 'meeting_plan',
  bridge?: FacetBridge,
): string {
  const operation = bridge?.tools.find((entry) => entry.name === 'meeting_plan')
  if (bridge && !operation)
    throw new Error('The installed app has no planning operation.')
  const routing = bridge
    ? ` Call ${bridge.tool} with {"tool":"meeting_plan","arguments":<input matching this original schema>}. Original schema: ${JSON.stringify(operation?.inputSchema)}.`
    : ''
  return `Turn these meeting notes into an action plan using ${bridge?.tool ?? tool}.${routing} Preserve this exact meeting title and the notes. Use source="host". Only assign owners or dates stated in the notes; leave missing values empty. Meeting title: ${JSON.stringify(plan.title)}\nNotes:\n${plan.notes}`
}

/** Ask for a plan without exposing transport details in user chat. @param plan User-authored meeting. @param installed Whether a verified Studio bridge opened this worksheet. @returns Natural-language request. */
export function planRequest(plan: Plan, installed = false): string {
  return `Please turn these notes into an action plan in ${installed ? 'this installed Meeting to Action worksheet opened through Facet Studio' : 'this Meeting to Action worksheet'}. Preserve the meeting title and notes. Only use owners and dates stated in the notes; leave anything unknown blank. Meeting title: ${JSON.stringify(plan.title)}\nNotes:\n${plan.notes}`
}

/** Deliver host state and open review only for a populated host proposal. @param agent State adapter. @param value Untrusted host plan. @param reviewed Review navigation callback. @returns State delivery completion. */
export async function receiveHostPlan(
  agent: MeetingAgent,
  value: unknown,
  reviewed: () => void,
): Promise<void> {
  const plan = parsePlan(value)
  await agent.accept(plan)
  if (
    plan.source === 'host' &&
    (plan.notes.trim() || plan.decisions.trim() || plan.actions.length > 0)
  )
    reviewed()
}
