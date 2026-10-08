import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { samplePlan } from '../src/model'

const file = resolve(process.argv[2] ?? 'dist/server.js')
const client = new Client({ name: 'meeting-smoke', version: '1.0.0' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [file],
    cwd: '/tmp',
    stderr: 'inherit',
  }),
)
try {
  const tools = await client.listTools()
  if (tools.tools.length !== 4) throw new Error('Expected four tools.')
  const resource = await client.readResource({
    uri: 'ui://meeting-to-action/view.html',
  })
  if (
    !resource.contents.some(
      (item) => 'text' in item && item.text.includes('<div id="root">'),
    )
  )
    throw new Error('Missing bundled UI.')
  const result = await client.callTool({
    name: 'meeting_plan',
    arguments: { plan: { ...samplePlan, source: 'host' } },
  })
  if (result.isError || !result.structuredContent)
    throw new Error('Plan tool failed.')
  const invalid = await client.callTool({
    name: 'meeting_plan',
    arguments: { plan: {} },
  })
  if (!invalid.isError) throw new Error('Invalid plan was accepted.')
  console.log(
    'PASS: stdio startup, four tools, inline MCP App resource, host plan, invalid input; launched from /tmp.',
  )
} finally {
  await client.close()
}
