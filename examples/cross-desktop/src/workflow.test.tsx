import { expect, test, spyOn } from 'bun:test'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { CopilotKitCoreReact } from '@copilotkit/react-core/v2/context'
import {
  HostStateAgent,
  Workflow,
  WorkflowProvider,
  WorkflowTools,
} from './workflow'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

for (const agentId of ['studio', 'meeting']) {
  test(`${agentId} actual CopilotKit renderer gates execution on approval and updates shared AG-UI state`, async () => {
    const agent = new HostStateAgent(agentId, { saved: false })
    const core = new CopilotKitCoreReact({
      agents__unsafe_dev_only: { [agentId]: agent },
    })
    const workflow = new Workflow(core, agentId)
    const run = spyOn(agent, 'run')
    const transportCalls: Record<string, unknown>[] = []
    workflow.configure({
      commit: {
        approval: true,
        run: async (input) => {
          transportCalls.push(input)
          await agent.receive(
            { saved: true, ...input },
            agentId === 'meeting' ? 'meeting_plan' : 'studio_install',
          )
          return { saved: true }
        },
      },
    })
    let view: ReactTestRenderer | undefined
    await act(async () => {
      view = create(
        <WorkflowProvider core={core}>
          <WorkflowTools workflow={workflow} />
        </WorkflowProvider>,
      )
    })
    try {
      expect(core.getTool({ toolName: 'review_action', agentId })?.type).toBe(
        'human-in-the-loop',
      )
      expect(core.renderToolCalls.map((tool) => tool.name)).toContain(
        'review_action',
      )
      await act(async () => {
        const denied = await core.runTool({
          name: 'execute_action',
          agentId,
          parameters: { operation: 'commit', input: { owner: 'Rae' } },
          followUp: false,
        })
        expect(denied.error).toBeDefined()
      })
      expect(transportCalls).toEqual([])
      let pending: Promise<Record<string, unknown>> | undefined
      await act(async () => {
        pending = workflow.invoke(
          'commit',
          { owner: 'Rae' },
          'Review change',
          'Confirm the owner before saving.',
        )
        await Promise.resolve()
      })
      expect(transportCalls).toEqual([])
      expect(JSON.stringify(view!.toJSON())).toContain('Review change')
      await act(async () => {
        view!.root
          .findAllByType('button')
          .find((button) => button.children.includes('Decline'))!
          .props.onClick()
        await pending
      })
      expect(await pending).toEqual({ declined: true })
      expect(transportCalls).toEqual([])
      await act(async () => {
        pending = workflow.invoke(
          'commit',
          { owner: 'Rae' },
          'Review change',
          'Confirm the owner before saving.',
        )
        await Promise.resolve()
      })
      await act(async () => {
        view!.root
          .findAllByType('button')
          .find((button) => button.children.includes('Approve'))!
          .props.onClick()
        await pending
      })
      expect(await pending).toEqual({ saved: true })
      expect(transportCalls).toEqual([{ owner: 'Rae' }])
      expect(run).toHaveBeenCalledTimes(1)
      expect(agent.state).toEqual({ saved: true, owner: 'Rae' })
      expect(
        agent.messages.filter((message) => message.role === 'tool').length,
      ).toBeGreaterThanOrEqual(4)
      expect(JSON.stringify(view!.toJSON())).toContain('Catalogue updated.')
      workflow.configure({
        commit: {
          approval: true,
          run: async () => {
            throw new Error('Transport unavailable')
          },
        },
      })
      await act(async () => {
        pending = workflow.invoke(
          'commit',
          { owner: 'Rae' },
          'Review failure',
          'Retry test.',
        )
        await Promise.resolve()
      })
      await act(async () => {
        view!.root
          .findAllByType('button')
          .find((button) => button.children.includes('Approve'))!
          .props.onClick()
        await expect(pending!).rejects.toThrow('could not finish')
      })
      expect(JSON.stringify(view!.toJSON())).toContain('Action failed.')
      expect(transportCalls).toHaveLength(1)
      await act(async () => {
        pending = workflow.invoke(
          'commit',
          { owner: 'Rae' },
          'Review cancellation',
          'Closing cancels.',
        )
        await Promise.resolve()
      })
      await act(async () => {
        view!.unmount()
      })
      await pending
      expect(await pending).toEqual({ declined: true })
    } finally {
      await act(async () => view?.unmount())
      run.mockRestore()
    }
  })
}
