import { describe, expect, test } from 'bun:test'
import { createCliSetup, type CliProcessRequest, type CliSetupOptions } from './cli-setup.js'

/** Build controlled children so races are deterministic. @returns Service, child controls and request log. */
function harness(overrides: CliSetupOptions = {}) {
  const children: { request: CliProcessRequest; finish(code: number): void; killed: boolean }[] = []
  const service = createCliSetup({
    discover: async () => '/configured/bin/facet',
    spawn(request) {
      let finish: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        finish = resolve
      })
      const child = { request, finish, killed: false }
      children.push(child)
      return {
        exited,
        kill: () => {
          child.killed = true
        },
      }
    },
    ...overrides,
  })
  return { service, children }
}

/** Yield to async discovery and completion callbacks. @returns Completion after the current microtask queue. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('CLI setup', () => {
  test('missing CLI does not spawn until an explicit install', async () => {
    const { service, children } = harness({ discover: async () => null })
    expect(await service.status()).toEqual({
      cli: 'missing',
      authentication: 'unknown',
      operation: 'idle',
    })
    expect(children).toHaveLength(0)
    expect((await service.login()).error).toBe('unavailable')
  })

  test('whoami success proves authentication without exposing identity or credentials', async () => {
    const { service, children } = harness()
    const status = service.status()
    await tick()
    children[0]!.request.onStdout('private <private@example.test>\nFACET_TOKEN=secret\n')
    children[0]!.finish(0)
    expect(await status).toEqual({
      cli: 'ready',
      authentication: 'authenticated',
      operation: 'idle',
    })
  })

  test('whoami outages do not claim authentication', async () => {
    const { service, children } = harness()
    const result = service.status()
    await tick()
    children[0]!.request.onStderr('secret internal failure')
    children[0]!.finish(1)
    expect((await result).authentication).toBe('unknown')
  })

  test('device fields are available from split chunks before exit and concurrent calls reuse child', async () => {
    const { service, children } = harness()
    const [first, second] = await Promise.all([service.login(), service.login()])
    expect(first.operation).toBe('starting-login')
    expect(second.operation).toBe('starting-login')
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child.request.args).toEqual(['login', '--no-browser'])
    for (const chunk of [
      'Vi',
      'sit https://login.agentfacets.io/device\nEnter co',
      'de: ABCD-',
      '1234\n',
    ])
      child.request.onStdout(chunk)
    expect(await service.status()).toEqual({
      cli: 'ready',
      authentication: 'unknown',
      operation: 'awaiting-login',
      verificationUrl: 'https://login.agentfacets.io/device',
      userCode: 'ABCD-1234',
    })
    child.finish(0)
    await tick()
    const status = service.status()
    await tick()
    children[1]!.finish(0)
    expect((await status).authentication).toBe('authenticated')
  })

  test('untrusted URLs and arbitrary output are not surfaced', async () => {
    const { service, children } = harness()
    await service.login()
    children[0]!.request.onStdout(
      'Visit https://evil.example/\nVisit https://secret@login.agentfacets.io/\nVisit https://login.agentfacets.io/?token=secret\nEnter code: valid secret\n',
    )
    expect(await service.status()).toEqual({
      cli: 'ready',
      authentication: 'unknown',
      operation: 'starting-login',
    })
    children[0]!.request.onStderr('TOKEN=secret')
    children[0]!.finish(1)
    await tick()
    expect(await service.status()).toEqual({
      cli: 'ready',
      authentication: 'unknown',
      operation: 'failed',
      error: 'login-failed',
    })
  })

  test('cancel kills child and late completion cannot overwrite a new attempt', async () => {
    const { service, children } = harness()
    await service.login()
    expect((await service.cancel()).operation).toBe('cancelled')
    expect(children[0]!.killed).toBe(true)
    await service.login()
    children[0]!.request.onStdout('Visit https://login.agentfacets.io/device\nEnter code: STALE\n')
    children[0]!.finish(0)
    await tick()
    expect((await service.status()).operation).toBe('starting-login')
    expect((await service.status()).userCode).toBeUndefined()
    await service.cancel()
  })

  test('cancel during discovery prevents spawning', async () => {
    let found: (value: string) => void = () => {}
    const { service, children } = harness({
      discover: () =>
        new Promise((resolve) => {
          found = resolve
        }),
    })
    const started = service.login()
    await service.cancel()
    found('/bin/facet')
    expect((await started).operation).toBe('cancelled')
    expect(children).toHaveLength(0)
  })

  test('timeout terminates an uncooperative process', async () => {
    const { service, children } = harness({ loginTimeoutMs: 5 })
    await service.login()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(children[0]!.killed).toBe(true)
    expect((await service.status()).error).toBe('timeout')
  })

  test('combined output limit kills child without exposing output', async () => {
    const { service, children } = harness({ maxOutputBytes: 12 })
    await service.login()
    children[0]!.request.onStdout('12345678')
    children[0]!.request.onStderr('secret')
    await tick()
    expect(children[0]!.killed).toBe(true)
    expect((await service.status()).error).toBe('output-limit')
  })

  test('official installer is explicit, avoids shell interpolation and verifies installation', async () => {
    let installed = false
    const { service, children } = harness({
      discover: async () => (installed ? '/custom/bin/facet' : null),
    })
    const result = service.install()
    await tick()
    expect(children[0]!.request.command).toBe('curl')
    expect(children[0]!.request.args.at(-1)).toBe('https://agentfacets.io/install')
    children[0]!.request.onStdout('#!/bin/bash\n# official script\n')
    children[0]!.finish(0)
    await tick()
    expect(children[1]!.request.command).toBe('bash')
    expect(children[1]!.request.args).toEqual(['-s', '--', '--no-modify-path'])
    expect(children[1]!.request.input).toContain('# official script')
    installed = true
    children[1]!.finish(0)
    await tick()
    expect(children[2]!.request.command).toBe('/custom/bin/facet')
    expect(children[2]!.request.args).toEqual(['--version'])
    children[2]!.finish(0)
    expect(await result).toEqual({ cli: 'ready', authentication: 'unknown', operation: 'idle' })
  })

  test('refused installer produces sanitized failure and never launches bash', async () => {
    const { service, children } = harness({ discover: async () => null })
    const result = service.install()
    await tick()
    children[0]!.request.onStderr('private proxy credentials')
    children[0]!.finish(22)
    expect((await result).error).toBe('install-failed')
    expect(children).toHaveLength(1)
  })

  test('spawn exceptions never escape with raw platform details', async () => {
    const { service } = harness({
      spawn: () => {
        throw new Error('secret path')
      },
    })
    await service.login()
    await tick()
    expect((await service.status()).error).toBe('login-failed')
  })
})
