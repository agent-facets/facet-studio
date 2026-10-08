import { useEffect, useState, type ReactNode } from 'react'
import {
  CopilotKitContext,
  CopilotKitCoreReact,
} from '@copilotkit/react-core/v2/context'
import {
  useAgent,
  useFrontendTool,
  useHumanInTheLoop,
  useRenderTool,
  useRenderToolCall,
} from '@copilotkit/react-core/v2/headless'
import { AbstractAgent } from '@ag-ui/client'
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type ToolMessage,
} from '@ag-ui/core'
import { Observable } from 'rxjs'
import { type } from 'arktype'

const OperationSchema = type({
  operation: 'string',
  input: 'object',
  'approvalId?': 'string',
})
const ApprovalSchema = type({ title: 'string', detail: 'string' })
const DecisionSchema = type({ approved: 'boolean' })
type Operation = {
  approval: boolean
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** Adapt actual host results into AG-UI state and tool lifecycle events. */
export class HostStateAgent extends AbstractAgent {
  private pending:
    | { snapshot: Record<string, unknown>; tool: string }
    | undefined
  /** Create local state without a model endpoint. @param id Agent identity. @param state Initial validated state. */
  constructor(id: string, state: Record<string, unknown>) {
    super({ agentId: id, initialState: state })
  }
  /** Queue an actual transport result. @param snapshot Validated shared state. @param tool Original host operation. @returns Applied AG-UI run. */
  async receive(
    snapshot: Record<string, unknown>,
    tool: string,
  ): Promise<void> {
    this.pending = { snapshot, tool }
    await this.runAgent()
  }
  /** Emit the actual result as a completed tool and state snapshot. @param input Run identity. @returns Event stream. */
  run(input: RunAgentInput): Observable<BaseEvent> {
    const result = this.pending
    this.pending = undefined
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      })
      if (result) {
        const id = crypto.randomUUID()
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: id,
          toolCallName: result.tool,
        })
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: id,
          delta: JSON.stringify(
            result.tool === 'meeting_plan'
              ? { plan: result.snapshot }
              : { query: result.snapshot.query ?? '' },
          ),
        })
        subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: id })
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: crypto.randomUUID(),
          toolCallId: id,
          content: JSON.stringify(result.snapshot),
          role: 'tool',
        })
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: result.snapshot,
        })
      }
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      })
      subscriber.complete()
    })
  }
}

/** Own approval receipts and execute operations exclusively through CopilotKit handlers. */
export class Workflow {
  private operations: Record<string, Operation> = {}
  private approvals = new Map<string, string>()
  private pending = false
  /** Attach a core and agent. @param core Real CopilotKit instance. @param agentId Registered agent identity. */
  constructor(
    readonly core: CopilotKitCoreReact,
    readonly agentId: string,
  ) {}
  /** Refresh transport adapters without replacing registered handlers. @param operations Allowed local actions. */
  configure(operations: Record<string, Operation>): void {
    this.operations = operations
  }
  /** Execute only allowlisted operations with single-use approval when required. @param value Validated frontend-tool envelope. @returns Adapter response. */
  async execute(
    value: typeof OperationSchema.infer,
  ): Promise<Record<string, unknown>> {
    const operation = this.operations[value.operation]
    if (!operation || Array.isArray(value.input))
      throw new Error('Unavailable worksheet action.')
    const signature = JSON.stringify([value.operation, value.input])
    if (operation.approval) {
      if (
        !value.approvalId ||
        this.approvals.get(value.approvalId) !== signature
      )
        throw new Error('Review and approve this action first.')
      this.approvals.delete(value.approvalId)
    }
    return {
      ok: true,
      value: await operation.run(value.input as Record<string, unknown>),
    }
  }
  /** Run the real approval tool before a side-effectful registered frontend tool. @param operation Allowed action. @param input Action snapshot. @param title Review heading. @param detail Review explanation. @returns Tool result or explicit decline. */
  async invoke(
    operation: string,
    input: Record<string, unknown>,
    title: string,
    detail: string,
  ): Promise<Record<string, unknown>> {
    if (this.pending) throw new Error('Finish the current review first.')
    const configured = this.operations[operation]
    if (!configured) throw new Error('Unavailable worksheet action.')
    input = structuredClone(input)
    this.pending = true
    let approvalId: string | undefined
    try {
      if (configured.approval) {
        const approval = await this.core.runTool({
          name: 'review_action',
          agentId: this.agentId,
          parameters: { title, detail },
          followUp: false,
        })
        if (approval.error) throw new Error('Review could not finish.')
        const decision = DecisionSchema(JSON.parse(approval.result))
        if (decision instanceof type.errors)
          throw new Error('Invalid review decision.')
        if (!decision.approved) return { declined: true }
        approvalId = approval.toolCallId
        this.approvals.set(approvalId, JSON.stringify([operation, input]))
      }
      const response = await this.core.runTool({
        name: 'execute_action',
        agentId: this.agentId,
        parameters: { operation, input, ...(approvalId ? { approvalId } : {}) },
        followUp: false,
      })
      if (response.error)
        throw new Error('The approved action could not finish.')
      const result: unknown = JSON.parse(response.result)
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('Invalid action result.')
      const envelope = type({ ok: 'true', value: 'object' })(result)
      if (envelope instanceof type.errors || Array.isArray(envelope.value))
        throw new Error('The action did not complete.')
      return envelope.value as Record<string, unknown>
    } finally {
      if (approvalId) this.approvals.delete(approvalId)
      this.pending = false
    }
  }
}

/** Supply live CopilotKit execution status to registered render components. @param props Core and children. @returns Context provider. */
export function WorkflowProvider({
  core,
  children,
}: {
  core: CopilotKitCoreReact
  children: ReactNode
}) {
  const [executing, setExecuting] = useState(new Set<string>())
  useEffect(
    () =>
      core.subscribe({
        onToolExecutionStart: ({ toolCallId }) =>
          setExecuting((current) => new Set([...current, toolCallId])),
        onToolExecutionEnd: ({ toolCallId }) =>
          setExecuting((current) => {
            const next = new Set(current)
            next.delete(toolCallId)
            return next
          }),
      }).unsubscribe,
    [core],
  )
  return (
    <CopilotKitContext.Provider
      value={{
        copilotkit: core,
        executingToolCallIds: executing,
        showIntelligenceIndicator: false,
      }}
    >
      {children}
    </CopilotKitContext.Provider>
  )
}

/** Resolve pending human review on a decision or removal of its visible card. @param props CopilotKit review state. @returns Approval controls. */
function ApprovalCard({
  args,
  status,
  respond,
  result,
}: {
  args: Partial<{ title: string; detail: string }>
  status: string
  respond?: (result: unknown) => Promise<void>
  result?: string
}) {
  useEffect(
    () => () => {
      void respond?.({ approved: false })
    },
    [respond],
  )
  return (
    <section className="workflow-review" aria-label="Action review">
      <strong>{args.title ?? 'Review action'}</strong>
      <p>{args.detail}</p>
      {status === 'executing' && respond ? (
        <div className="workflow-actions">
          <button onClick={() => void respond({ approved: false })}>
            Decline
          </button>
          <button onClick={() => void respond({ approved: true })}>
            Approve
          </button>
        </div>
      ) : (
        <p role="status">
          {status === 'complete'
            ? result?.includes('true')
              ? 'Approved'
              : 'Declined'
            : 'Preparing review…'}
        </p>
      )}
    </section>
  )
}

/** Describe completion only when the registered handler returned a success envelope. @param result Tool result. @param operation Operation identity. @returns User-facing outcome. */
function completion(
  result: string | undefined,
  operation: string | undefined,
): string {
  try {
    const value: unknown = JSON.parse(result ?? 'null')
    if (type({ ok: 'true', value: 'object' })(value) instanceof type.errors)
      return 'Action failed. Review the message below and retry.'
    return operation === 'install'
      ? 'Facet installed. Ready to open.'
      : operation === 'save'
        ? 'Approved plan saved for this server session.'
        : 'Catalogue updated.'
  } catch {
    return 'Action failed. Review the message below and retry.'
  }
}

/** Register real human review and execution tools, then render their agent history in place. @param props Workflow runtime. @returns Compact interactive tool cards. */
export function WorkflowTools({ workflow }: { workflow: Workflow }) {
  const { agent } = useAgent({ agentId: workflow.agentId })
  useHumanInTheLoop({
    name: 'review_action',
    agentId: workflow.agentId,
    parameters: ApprovalSchema,
    followUp: false,
    render: ApprovalCard,
  })
  useFrontendTool({
    name: 'execute_action',
    agentId: workflow.agentId,
    parameters: OperationSchema,
    followUp: false,
    handler: async (args) => workflow.execute(args),
    render: ({ status, result, args }) => (
      <p className="workflow-result" role="status">
        {status === 'complete'
          ? completion(result, args.operation)
          : 'Applying action…'}
      </p>
    ),
  })
  const hostTool =
    workflow.agentId === 'meeting' ? 'meeting_plan' : 'studio_search'
  useRenderTool({
    name: hostTool,
    agentId: workflow.agentId,
    parameters: type({ 'plan?': 'object', 'query?': 'string' }),
    render: () => (
      <p className="workflow-result" role="status">
        {workflow.agentId === 'meeting'
          ? 'Plan received. Review the worksheet, then approve saving.'
          : 'Catalogue updated. Choose a facet to review its installation.'}
      </p>
    ),
  })
  const render = useRenderToolCall()
  const calls = agent.messages
    .flatMap((message) =>
      message.role === 'assistant' ? (message.toolCalls ?? []) : [],
    )
    .filter((call) =>
      ['review_action', 'execute_action', hostTool].includes(
        call.function.name,
      ),
    )
    .slice(-2)
  return (
    <div className="workflow-tools">
      {calls.map((toolCall) =>
        render({
          toolCall,
          toolMessage: agent.messages.find(
            (message): message is ToolMessage =>
              message.role === 'tool' && message.toolCallId === toolCall.id,
          ),
        }),
      )}
    </div>
  )
}
