import { expect, test } from 'bun:test'
import { App } from '@modelcontextprotocol/ext-apps'
import { MeetingAgent } from './agent'
import { connectBridge, planRequest, receiveHostPlan } from './bridge'
import { emptyPlan, samplePlan } from './model'

test('assistant request retains the exact title and notes', () => {
  const plan = { ...samplePlan, title: 'Pilot readiness' }
  expect(planRequest(plan)).toContain('Meeting title: "Pilot readiness"')
  expect(planRequest(plan)).toContain(plan.notes)
})

test('only populated incoming host proposals open Review', async () => {
  const agent = new MeetingAgent()
  let opened = 0
  const review = () => {
    opened += 1
  }
  await receiveHostPlan(agent, emptyPlan, review)
  await receiveHostPlan(agent, samplePlan, review)
  await receiveHostPlan(agent, { ...samplePlan, source: 'edited' }, review)
  expect(opened).toBe(0)
  await receiveHostPlan(
    agent,
    { ...samplePlan, title: 'Pilot readiness', source: 'host' },
    review,
  )
  expect(opened).toBe(1)
  expect(agent.state.title).toBe('Pilot readiness')
  agent.setState({ ...agent.state, title: 'Edited locally' })
  expect(opened).toBe(1)
})

test('host bridge waits for routing metadata before its first server call', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: {} },
  })
  const app = new App({ name: 'test', version: '1' }, {})
  app.connect = async () => {}
  const calls: string[] = []
  app.callServerTool = async (params) => {
    calls.push(params.name)
    return { content: [], structuredContent: { plan: samplePlan } }
  }
  try {
    let ready = false
    const pending = connectBridge(
      new MeetingAgent(),
      () => {
        ready = true
      },
      () => {},
      () => {},
      () => app,
    )
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(calls).toEqual([])
    app.ontoolresult?.({
      content: [],
      structuredContent: { plan: samplePlan },
      _meta: { facetToolNames: { meeting_plan: 'app_example_plan' } },
    })
    const bridge = await pending
    await bridge.call('meeting_plan', { plan: samplePlan })
    expect(calls).toEqual(['app_example_plan'])
    expect(planRequest(samplePlan, 'app_example_plan')).toContain(
      'using app_example_plan.',
    )
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
    await app.close()
  }
})
