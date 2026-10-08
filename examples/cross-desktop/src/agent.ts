import { AbstractAgent } from '@ag-ui/client'
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core'
import { Observable } from 'rxjs'
import { emptyPlan, parsePlan, type Plan } from './model'

/** Carry host tool results through the AG-UI state protocol without calling a model. */
export class MeetingAgent extends AbstractAgent {
  private nextPlan: Plan = emptyPlan

  /** Initialize the shared React state. @returns A locally managed AG-UI agent. */
  constructor() {
    super({ agentId: 'meeting', initialState: emptyPlan })
  }

  /** Apply a validated host result. @param value Incoming plan. @returns Completion of state delivery. */
  async accept(value: unknown): Promise<void> {
    this.nextPlan = parsePlan(value)
    await this.runAgent()
  }

  /** Emit the host-provided snapshot. @param input Run identity. @returns AG-UI lifecycle and state events. */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      })
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: this.nextPlan,
      })
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      })
      subscriber.complete()
    })
  }
}
