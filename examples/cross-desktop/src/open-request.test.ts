import { expect, test } from 'bun:test'
import { App } from '@modelcontextprotocol/ext-apps'
import { requestOpen } from './open-request'

test('Open keeps routing hidden and awaits context before natural message, including fallback', async () => {
  for (const mode of [
    'text',
    'structured',
    'unsupported',
    'refused',
  ] as const) {
    const app = new App({ name: 'test', version: '1' }, {})
    const events: string[] = []
    app.getHostCapabilities = () =>
      mode === 'unsupported'
        ? {}
        : {
            updateModelContext:
              mode === 'structured'
                ? { structuredContent: true }
                : { text: true },
          }
    app.updateModelContext = async (params, options) => {
      events.push('context')
      expect(JSON.stringify(params)).toContain('studio_app_example')
      expect(options?.timeout).toBe(3000)
      if (mode === 'refused') throw new Error('refused')
      await Promise.resolve()
      events.push('acknowledged')
      return {}
    }
    app.sendMessage = async (params) => {
      events.push('message')
      expect(params.content).toEqual([
        {
          type: 'text',
          text: 'Open Meeting to Action so I can start using it here.',
        },
      ])
      expect(JSON.stringify(params)).not.toContain('studio_app_example')
      expect(JSON.stringify(params)).not.toContain('arguments')
      return {}
    }
    await requestOpen(app, {
      name: 'Meeting to Action',
      openTool: 'studio_app_example',
    })
    expect(events).toEqual(
      mode === 'unsupported'
        ? ['message']
        : mode === 'refused'
          ? ['context', 'message']
          : ['context', 'acknowledged', 'message'],
    )
  }
})
