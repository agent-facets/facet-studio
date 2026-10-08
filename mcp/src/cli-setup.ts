import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export type CliSetupStatus = {
  cli: 'missing' | 'ready'
  authentication: 'unknown' | 'signed-out' | 'authenticated'
  operation: 'idle' | 'installing' | 'starting-login' | 'awaiting-login' | 'failed' | 'cancelled'
  verificationUrl?: string
  userCode?: string
  error?: 'unavailable' | 'install-failed' | 'login-failed' | 'timeout' | 'output-limit'
}

export type CliProcess = { exited: Promise<number>; kill(): void }
export type CliProcessRequest = {
  command: string
  args: string[]
  input?: string
  onStdout(chunk: string): void
  onStderr(chunk: string): void
}
export type CliSetupOptions = {
  discover?: () => Promise<string | null>
  spawn?: (request: CliProcessRequest) => CliProcess
  commandTimeoutMs?: number
  loginTimeoutMs?: number
  installTimeoutMs?: number
  maxOutputBytes?: number
  verificationOrigins?: string[]
}
export type CliSetupService = {
  status(): Promise<CliSetupStatus>
  install(): Promise<CliSetupStatus>
  login(): Promise<CliSetupStatus>
  cancel(): Promise<CliSetupStatus>
}

type RunResult = { code: number; output: string; error?: 'timeout' | 'output-limit' }

/** Spawn without a shell. @param request Fixed executable and argument vector. @returns A killable child handle. */
function spawnProcess(request: CliProcessRequest): CliProcess {
  const child = spawn(request.command, request.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', request.onStdout)
  child.stderr.on('data', request.onStderr)
  child.stdin.on('error', () => {})
  child.stdin.end(request.input)
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(-1))
    child.once('close', (code) => resolve(code ?? -1))
  })
  return {
    exited,
    kill: () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* An already-exited process has nothing left to terminate. */
      }
    },
  }
}

/** Locate executable CLI candidates without reading credentials. @returns First executable path, or null. */
async function discoverCli(): Promise<string | null> {
  const home = homedir()
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    join(process.env.FACET_DIR ?? join(home, '.facet'), 'bin'),
    join(process.env.BUN_INSTALL ?? join(home, '.bun'), 'bin'),
  ]
  for (const directory of directories) {
    const candidate = join(directory, 'facet')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* A missing candidate permits trying the next configured location. */
    }
  }
  return null
}

/** Clamp resource limits supplied by trusted host code. @param value Optional limit. @param fallback Default. @param ceiling Maximum. @returns A finite positive limit. */
function limit(value: number | undefined, fallback: number, ceiling: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, ceiling)
    : fallback
}

/** Create a local CLI setup coordinator; credentials remain CLI-owned. @param options Process ports and resource limits. @returns Setup operations and pollable state. */
export function createCliSetup(options: CliSetupOptions = {}): CliSetupService {
  const discover = options.discover ?? discoverCli
  const spawnChild = options.spawn ?? spawnProcess
  const commandTimeout = limit(options.commandTimeoutMs, 15_000, 60_000)
  const loginTimeout = limit(options.loginTimeoutMs, 600_000, 900_000)
  const installTimeout = limit(options.installTimeoutMs, 120_000, 300_000)
  const outputLimit = limit(options.maxOutputBytes, 524_288, 1_048_576)
  const origins = new Set(options.verificationOrigins ?? ['https://login.agentfacets.io'])
  let state: CliSetupStatus = { cli: 'missing', authentication: 'unknown', operation: 'idle' }
  let generation = 0
  let busy = false
  let stop: (() => void) | undefined

  /** Copy public state so callers cannot mutate it. @returns Sanitized setup snapshot. */
  function snapshot(): CliSetupStatus {
    return { ...state }
  }

  /** Run one child with bounded output and lifetime. @param command Executable. @param args Arguments. @param timeout Deadline. @param input Optional stdin. @param onOutput Optional live stdout parser. @returns Sanitized exit and private bounded stdout. */
  function run(
    command: string,
    args: string[],
    timeout: number,
    input?: string,
    onOutput?: (chunk: string) => void,
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      let child: CliProcess | undefined
      let done = false
      let output = ''
      let bytes = 0
      /** Finish once, killing the child on interruption. @param result Terminal result. @param kill Whether to terminate. @returns Nothing. */
      function finish(result: RunResult, kill = false): void {
        if (done) return
        done = true
        clearTimeout(timer)
        if (stop === cancelRun) stop = undefined
        if (kill) child?.kill()
        resolve(result)
      }
      /** Cancel this child without waiting for process cooperation. @returns Nothing. */
      function cancelRun(): void {
        finish({ code: -1, output: '' }, true)
      }
      /** Account for both streams before parsing or retaining output. @param chunk Output fragment. @param stdout Whether stdout. @returns Nothing. */
      function receive(chunk: string, stdout: boolean): void {
        if (done) return
        bytes += Buffer.byteLength(chunk)
        if (bytes > outputLimit)
          return finish({ code: -1, output: '', error: 'output-limit' }, true)
        if (stdout) {
          output += chunk
          onOutput?.(chunk)
        }
      }
      const timer = setTimeout(
        () => finish({ code: -1, output: '', error: 'timeout' }, true),
        timeout,
      )
      stop = cancelRun
      try {
        child = spawnChild({
          command,
          args,
          input,
          onStdout: (chunk) => receive(chunk, true),
          onStderr: (chunk) => receive(chunk, false),
        })
        if (done) child.kill()
        void child.exited.then(
          (code) => finish({ code, output }),
          () => finish({ code: -1, output: '' }),
        )
      } catch {
        finish({ code: -1, output: '' })
      }
    })
  }

  /** Discover a CLI while suppressing private platform errors. @returns Executable or null. */
  async function locate(): Promise<string | null> {
    try {
      return await discover()
    } catch {
      return null
    }
  }

  /** Probe identity only when no mutating operation is active. @returns Current public state. */
  async function status(): Promise<CliSetupStatus> {
    if (busy || state.operation !== 'idle') return snapshot()
    busy = true
    const epoch = generation
    try {
      const binary = await locate()
      if (epoch !== generation) return snapshot()
      if (!binary) {
        state = { cli: 'missing', authentication: 'unknown', operation: 'idle' }
        return snapshot()
      }
      const result = await run(binary, ['whoami'], commandTimeout)
      if (epoch === generation)
        state = {
          cli: 'ready',
          authentication: result.code === 0 ? 'authenticated' : 'unknown',
          operation: 'idle',
        }
      return snapshot()
    } finally {
      if (epoch === generation) busy = false
    }
  }

  /** Install through the official HTTPS script without modifying shell startup files. @returns Verified CLI state or sanitized failure. */
  async function install(): Promise<CliSetupStatus> {
    if (busy) return snapshot()
    busy = true
    const epoch = ++generation
    state = {
      ...state,
      operation: 'installing',
      error: undefined,
      verificationUrl: undefined,
      userCode: undefined,
    }
    try {
      let binary = await locate()
      if (epoch !== generation) return snapshot()
      if (!binary) {
        const script = await run(
          'curl',
          [
            '--fail',
            '--silent',
            '--show-error',
            '--location',
            '--proto',
            '=https',
            '--proto-redir',
            '=https',
            '--max-time',
            '30',
            'https://agentfacets.io/install',
          ],
          commandTimeout,
        )
        if (epoch !== generation) return snapshot()
        if (script.code !== 0 || !script.output.trim()) {
          state = { ...state, operation: 'failed', error: script.error ?? 'install-failed' }
          return snapshot()
        }
        const result = await run(
          'bash',
          ['-s', '--', '--no-modify-path'],
          installTimeout,
          script.output,
        )
        if (epoch !== generation) return snapshot()
        if (result.code !== 0) {
          state = { ...state, operation: 'failed', error: result.error ?? 'install-failed' }
          return snapshot()
        }
        binary = await locate()
        if (epoch !== generation) return snapshot()
      }
      const result = binary ? await run(binary, ['--version'], commandTimeout) : undefined
      if (epoch === generation)
        state =
          result?.code === 0
            ? { cli: 'ready', authentication: 'unknown', operation: 'idle' }
            : {
                cli: 'missing',
                authentication: 'unknown',
                operation: 'failed',
                error: result?.error ?? 'install-failed',
              }
      return snapshot()
    } finally {
      if (epoch === generation) busy = false
    }
  }

  /** Start CLI-owned device login and return before browser approval. @returns Live device-flow state. */
  async function login(): Promise<CliSetupStatus> {
    if (busy) return snapshot()
    busy = true
    const epoch = ++generation
    state = { cli: state.cli, authentication: 'unknown', operation: 'starting-login' }
    const binary = await locate()
    if (epoch !== generation) return snapshot()
    if (!binary) {
      busy = false
      state = {
        cli: 'missing',
        authentication: 'unknown',
        operation: 'failed',
        error: 'unavailable',
      }
      return snapshot()
    }
    state.cli = 'ready'
    let pending = ''
    /** Parse complete lines only; allow HTTPS device URLs from configured origins. @param chunk stdout fragment. @returns Nothing. */
    function parse(chunk: string): void {
      if (epoch !== generation) return
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (line.startsWith('Visit ')) {
          try {
            const url = new URL(line.slice(6))
            if (
              url.protocol === 'https:' &&
              origins.has(url.origin) &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            )
              state.verificationUrl = url.href
          } catch {
            /* Malformed output is not a browser navigation target. */
          }
        }
        const code = /^Enter code: ([A-Z0-9-]{4,32})$/.exec(line)?.[1]
        if (code) state.userCode = code
      }
      if (state.verificationUrl && state.userCode) state.operation = 'awaiting-login'
    }
    void run(binary, ['login', '--no-browser'], loginTimeout, undefined, parse).then((result) => {
      if (epoch !== generation) return
      busy = false
      state =
        result.code === 0
          ? { cli: 'ready', authentication: 'authenticated', operation: 'idle' }
          : {
              cli: 'ready',
              authentication: 'unknown',
              operation: 'failed',
              error: result.error ?? 'login-failed',
            }
    })
    return snapshot()
  }

  /** Invalidate pending work before terminating its child to prevent stale completion. @returns Cancelled public state. */
  async function cancel(): Promise<CliSetupStatus> {
    ++generation
    stop?.()
    busy = false
    state = { cli: state.cli, authentication: 'unknown', operation: 'cancelled' }
    return snapshot()
  }
  return { status, install, login, cancel }
}
