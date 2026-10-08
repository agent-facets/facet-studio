import { HostStateAgent } from './workflow'
import { emptyPlan, parsePlan } from './model'

/** Carry validated meeting results through the shared AG-UI tool/state lifecycle. */
export class MeetingAgent extends HostStateAgent {
  /** Initialize the local meeting agent without a model endpoint. */
  constructor() {
    super('meeting', emptyPlan)
  }
  /** Apply a real host plan or saved snapshot. @param value Transport result. @returns State delivery completion. */
  async accept(value: unknown): Promise<void> {
    await this.receive(parsePlan(value), 'meeting_plan')
  }
}
