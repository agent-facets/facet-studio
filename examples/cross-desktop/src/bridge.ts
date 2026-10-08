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
export type Bridge = {
  connected: boolean
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
): Promise<Bridge> {
  if (window.parent === window) {
    const bridge: Bridge = {
      connected: false,
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
  const app = new App({ name: 'Meeting to Action', version: '0.1.0' }, {})
  app.ontoolresult = (result) => {
    const payload = result.structuredContent
    if (payload?.plan)
      void receiveHostPlan(agent, payload.plan, hostPlanReceived).catch(() =>
        failed(
          'The assistant returned an invalid plan. Ask it to correct the tool input.',
        ),
      )
  }
  app.onhostcontextchanged = (context) => {
    if (context.theme) document.documentElement.dataset.theme = context.theme
  }
  await app.connect()
  const context = app.getHostContext()
  if (context?.theme) document.documentElement.dataset.theme = context.theme
  const bridge: Bridge = {
    connected: true,
    async call(name, args = {}) {
      const result = await app.callServerTool({ name, arguments: args })
      if (result.isError)
        throw new Error(
          'The host could not complete the request. Try again in the conversation.',
        )
      return record(result.structuredContent)
    },
    async request(plan) {
      const result = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: planRequest(plan),
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
export function planRequest(plan: Plan): string {
  return `Turn these meeting notes into an action plan using meeting_plan. Preserve this exact meeting title and the notes. Use source="host". Only assign owners or dates stated in the notes; leave missing values empty. Meeting title: ${JSON.stringify(plan.title)}\nNotes:\n${plan.notes}`
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
