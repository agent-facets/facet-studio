import { expect, test } from 'bun:test'
import { App } from '@modelcontextprotocol/ext-apps'
import { MeetingAgent } from './agent'
import {
  connectBridge,
  planRequest,
  planModelContext,
  receiveHostPlan,
} from './bridge'
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
    expect(bridge.installed).toBe(false)
    expect(planModelContext(samplePlan, 'app_example_plan')).toContain(
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
    expect(bridge.installed).toBe(true)
    expect(prompt).not.toContain(metadata.tool)
    expect(prompt).not.toContain('meeting_plan')
    expect(prompt).not.toContain('Original schema')
    expect(prompt).not.toContain('source=')
    expect(prompt).toContain(
      'installed Meeting to Action worksheet opened through Facet Studio',
    )
    expect(planModelContext(samplePlan, undefined, metadata)).toContain(
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

test('model context is acknowledged before a plain request and optional failures retain a natural fallback', async () => {
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
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: {} },
  })
  try {
    for (const mode of [
      'text',
      'structured',
      'unsupported',
      'refused',
    ] as const) {
      const app = new App({ name: 'test', version: '1' }, {})
      app.connect = async () => {}
      app.getHostCapabilities = () =>
        mode === 'unsupported'
          ? {}
          : {
              updateModelContext:
                mode === 'structured'
                  ? { structuredContent: {} }
                  : { text: {} },
            }
      const acknowledgment = Promise.withResolvers<void>()
      const events: string[] = []
      let context = ''
      let timeout: number | undefined
      let visible = ''
      app.updateModelContext = async (params, options) => {
        events.push('context')
        context = JSON.stringify(params)
        timeout = options?.timeout
        if (mode === 'refused') throw new Error('unsupported by host')
        await acknowledgment.promise
        events.push('acknowledged')
        return {}
      }
      app.sendMessage = async (params) => {
        events.push('message')
        visible = JSON.stringify(params.content)
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
        const request = bridge.request({
          ...samplePlan,
          title: 'Pilot readiness',
        })
        await Promise.resolve()
        if (mode === 'text' || mode === 'structured') {
          expect(events).toEqual(['context'])
          acknowledgment.resolve()
        }
        await request
        expect(events).toEqual(
          mode === 'unsupported'
            ? ['message']
            : mode === 'refused'
              ? ['context', 'message']
              : ['context', 'acknowledged', 'message'],
        )
        if (mode !== 'unsupported') {
          expect(timeout).toBe(3000)
          expect(context).toContain(metadata.tool)
          expect(context).toContain('meeting_plan')
          expect(context).toContain('Original schema')
          expect(context).toContain('Pilot readiness')
        }
        expect(visible).toContain('Pilot readiness')
        expect(visible).toContain(samplePlan.notes.split('\n')[0]!)
        for (const detail of [
          metadata.tool,
          'meeting_plan',
          'inputSchema',
          'Original schema',
          'source=',
          'arguments',
        ])
          expect(visible).not.toContain(detail)
      } finally {
        await app.close()
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('browser remains uninstalled and cannot request host reasoning', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const browser: { parent?: unknown } = {}
  browser.parent = browser
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: browser,
  })
  try {
    const bridge = await connectBridge(
      new MeetingAgent(),
      () => {},
      () => {},
      () => {},
    )
    expect(bridge.connected).toBe(false)
    expect(bridge.installed).toBe(false)
    await expect(bridge.request(samplePlan)).rejects.toThrow(
      'unavailable in this browser',
    )
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('real SDK model-context timeout falls back to one plain request', async () => {
  const { AppBridge } = await import(
    '@modelcontextprotocol/ext-apps/app-bridge'
  )
  const { InMemoryTransport } = await import(
    '@modelcontextprotocol/sdk/inMemory.js'
  )
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: {} },
  })
  const host = new AppBridge(
    null,
    { name: 'timeout-host', version: '1' },
    { updateModelContext: { text: {} }, message: { text: {} } },
  )
  const app = new App({ name: 'test', version: '1' }, {}, { autoResize: false })
  const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair()
  const connect = app.connect.bind(app)
  app.connect = async () => connect(appTransport)
  let contextCalls = 0
  let visible = ''
  let messages = 0
  host.onupdatemodelcontext = () => {
    contextCalls += 1
    return new Promise(() => {})
  }
  host.onmessage = async (params) => {
    messages += 1
    visible = JSON.stringify(params.content)
    return {}
  }
  host.oninitialized = () => {
    void (async () => {
      await host.sendToolInput({ arguments: {} })
      await host.sendToolResult({
        content: [],
        structuredContent: { plan: samplePlan },
        _meta: {
          facetBridge: {
            tool: 'studio_app_0123456789abcdef',
            appId: 'meeting-to-action',
            tools: [{ name: 'meeting_plan', inputSchema: { type: 'object' } }],
          },
        },
      })
    })()
  }
  try {
    await host.connect(hostTransport)
    const bridge = await connectBridge(
      new MeetingAgent(),
      () => {},
      () => {},
      () => {},
      () => app,
    )
    const started = Date.now()
    await bridge.request(samplePlan)
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900)
    expect(Date.now() - started).toBeLessThan(4500)
    expect(contextCalls).toBe(1)
    expect(messages).toBe(1)
    expect(visible).toContain('installed Meeting to Action worksheet')
    expect(visible).not.toContain('studio_app_')
    expect(visible).not.toContain('Original schema')
  } finally {
    await app.close()
    await host.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}, 6000)
