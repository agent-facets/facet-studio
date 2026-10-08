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

test('stable bridge validates metadata and routes UI calls and assistant requests exactly', async () => {
  const { parseFacetBridge } = await import('./bridge')
  const metadata = {
    tool: 'studio_app_0123456789abcdef',
    appId: 'meeting-to-action',
    tools: [
      {
        name: 'meeting_plan',
        inputSchema: { type: 'object', required: ['plan'] },
      },
    ],
  }
  expect(parseFacetBridge(metadata)).toEqual(metadata)
  for (const value of [
    { ...metadata, tool: 'bad' },
    { ...metadata, tools: [...metadata.tools, ...metadata.tools] },
    { ...metadata, tools: [{ name: 'bad/tool', inputSchema: {} }] },
    { ...metadata, tools: [{ name: 'meeting_plan', inputSchema: [] }] },
  ])
    expect(() => parseFacetBridge(value)).toThrow()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: {} },
  })
  const app = new App({ name: 'test', version: '1' }, {})
  app.connect = async () => {}
  const calls: unknown[] = []
  let prompt = ''
  app.callServerTool = async (params) => {
    calls.push(params)
    return { content: [], structuredContent: { plan: samplePlan } }
  }
  app.sendMessage = async (params) => {
    prompt = JSON.stringify(params.content)
    return {}
  }
  try {
    const pending = connectBridge(
      new MeetingAgent(),
      () => {},
      () => {},
      () => {},
      () => app,
    )
    app.ontoolresult?.({
      content: [],
      structuredContent: { plan: samplePlan },
      _meta: { facetBridge: metadata },
    })
    const bridge = await pending
    await bridge.call('meeting_plan', { plan: samplePlan })
    expect(calls).toEqual([
      {
        name: metadata.tool,
        arguments: { tool: 'meeting_plan', arguments: { plan: samplePlan } },
      },
    ])
    await expect(bridge.call('unknown')).rejects.toThrow('does not expose')
    await bridge.request(samplePlan)
    expect(prompt).toContain(metadata.tool)
    expect(prompt).toContain('meeting_plan')
    expect(prompt).toContain('Original schema')
    expect(planRequest(samplePlan, undefined, metadata)).toContain(
      '"tool":"meeting_plan","arguments":',
    )
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
    await app.close()
  }
})

test('bridge metadata accepts the same exact schema-size boundary as the proxy', async () => {
  const { parseFacetBridge } = await import('./bridge')
  const tools = [
    { name: 'meeting_plan', description: '', inputSchema: { type: 'object' } },
  ]
  tools[0]!.description = 'x'.repeat(128 * 1024 - JSON.stringify(tools).length)
  const metadata = {
    tool: 'studio_app_0123456789abcdef',
    appId: 'meeting-to-action',
    tools,
  }
  expect(JSON.stringify(tools).length).toBe(128 * 1024)
  expect(parseFacetBridge(metadata).tools).toEqual(tools)
  tools[0]!.description += 'x'
  expect(() => parseFacetBridge(metadata)).toThrow()
})
