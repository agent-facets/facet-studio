import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@modelcontextprotocol/ext-apps'
import { type } from 'arktype'
import './studio-style.css'
import { contextQuery } from './search'
import { requestOpen } from './open-request'
import { useAgent } from '@copilotkit/react-core/v2/headless'
import { CopilotKitCoreReact } from '@copilotkit/react-core/v2/context'
import {
  HostStateAgent,
  Workflow,
  WorkflowProvider,
  WorkflowTools,
} from './workflow'
const studioAgent = new HostStateAgent('studio', { items: [], query: '' })
const studioCore = new CopilotKitCoreReact({
  agents__unsafe_dev_only: { studio: studioAgent },
})
const workflow = new Workflow(studioCore, 'studio')

const ItemSchema = type({
  id: 'string > 0',
  name: 'string > 0',
  description: 'string',
  version: 'string',
  source: "'local'",
  installed: 'boolean',
  'openTool?': 'string',
})
const SearchSchema = type({
  items: ItemSchema.array().atMostLength(100),
  'query?': 'string',
})
const InstallSchema = type({
  item: ItemSchema,
  app: {
    id: 'string > 0',
    openTool: 'string > 0',
    toolNames: { '[string]': 'string' },
  },
})
const SetupSchema = type({
  cli: "'missing' | 'ready'",
  authentication: "'unknown' | 'signed-out' | 'authenticated'",
  operation:
    "'idle' | 'installing' | 'starting-login' | 'awaiting-login' | 'failed' | 'cancelled'",
  'verificationUrl?': 'string',
  'userCode?': 'string',
  'error?':
    "'unavailable' | 'install-failed' | 'login-failed' | 'timeout' | 'output-limit'",
})
type CatalogueItem = typeof ItemSchema.infer
type SetupStatus = typeof SetupSchema.infer
type Busy =
  | ''
  | 'search'
  | 'install'
  | 'open'
  | 'setup-install'
  | 'login'
  | 'cancel'
  | 'status'
type SetupAction = 'status' | 'install' | 'login' | 'cancel'

/** Validate an envelope without displaying private server errors. @param value Tool payload. @returns Public payload object. */
function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid tool response.')
  return value as Record<string, unknown>
}

/** Validate CLI fields before offering navigation. @param value Setup payload. @returns Safe setup state. */
function parseSetup(value: unknown): SetupStatus {
  const setup = SetupSchema(value)
  if (setup instanceof type.errors) throw new Error('Invalid setup response.')
  if (setup.verificationUrl) {
    const url = new URL(setup.verificationUrl)
    if (
      url.origin !== 'https://login.agentfacets.io' ||
      url.pathname !== '/device' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid verification address.')
  }
  if (setup.userCode && !/^[A-Z0-9-]{4,32}$/.test(setup.userCode))
    throw new Error('Invalid verification code.')
  return setup
}

/** Follow the host on connection and later theme changes. @param theme Host theme. @returns Nothing. */
function applyTheme(theme: string | undefined): void {
  if (theme === 'light' || theme === 'dark')
    document.documentElement.dataset.theme = theme
}

/** Render compact inline discovery and the installed-app handoff. @returns Studio catalogue card. */
function Studio() {
  const appRef = useRef<App | null>(null)
  const alive = useRef(false)
  const operation = useRef(0)
  const busyRef = useRef<Busy>('')
  const [connected, setConnected] = useState(false)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const { agent } = useAgent({ agentId: 'studio' })
  const items = SearchSchema.assert(agent.state).items
  const [setup, setSetup] = useState<SetupStatus>()
  const [setupUnavailable, setSetupUnavailable] = useState(false)
  const [busy, setBusy] = useState<Busy>('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  /** Apply real catalogue results. @param value Tool payload. @returns Nothing. */
  function receiveSearch(value: unknown): void {
    const result = SearchSchema(value)
    if (result instanceof type.errors)
      throw new Error('Invalid catalogue response.')
    void studioAgent.receive(
      { ...result, query: result.query ?? searched },
      'studio_search',
    )
    setNotice(
      `${result.items.length} local ${result.items.length === 1 ? 'facet' : 'facets'} found.`,
    )
    const initialQuery = contextQuery(result)
    if (initialQuery !== undefined) {
      setQuery(initialQuery)
      setSearched(initialQuery)
    }
  }

  useEffect(() => {
    alive.current = true
    if (window.parent === window) {
      setError(
        'Open Facet Studio inside your assistant to search and install facets.',
      )
      return () => {
        alive.current = false
      }
    }
    const app = new App({ name: 'Facet Studio', version: '0.1.3' }, {})
    appRef.current = app
    app.ontoolinput = (input) => {
      if (!alive.current) return
      const value = contextQuery(input.arguments)
      if (typeof value === 'string') {
        setQuery(value)
        setSearched(value)
      }
    }
    app.ontoolresult = (result) => {
      if (!alive.current) return
      try {
        const value = payload(result.structuredContent)
        if ('items' in value) receiveSearch(value)
      } catch {
        setError(
          'The catalogue response could not be read. Search again to retry.',
        )
      }
    }
    app.onhostcontextchanged = (context) => applyTheme(context.theme)
    void app
      .connect()
      .then(async () => {
        if (!alive.current) return
        applyTheme(app.getHostContext()?.theme)
        setConnected(true)
        try {
          const result = await app.callServerTool({
            name: 'studio_setup',
            arguments: { action: 'status' },
          })
          if (result.isError) throw new Error('Setup unavailable.')
          const next = parseSetup(payload(result.structuredContent).setup)
          if (alive.current) setSetup(next)
        } catch {
          if (alive.current) setSetupUnavailable(true)
        }
      })
      .catch(() => {
        if (alive.current)
          setError(
            'Studio could not connect. Reopen the catalogue tool in your assistant.',
          )
      })
    return () => {
      alive.current = false
      ++operation.current
      appRef.current = null
      void app.close()
    }
  }, [])

  useEffect(() => {
    if (
      !connected ||
      !setup ||
      !['installing', 'starting-login', 'awaiting-login'].includes(
        setup.operation,
      )
    )
      return
    let active = true
    let polling = false
    const timer = window.setInterval(() => {
      if (polling) return
      polling = true
      void call('studio_setup', { action: 'status' })
        .then((result) => {
          const next = parseSetup(result.setup)
          if (active) {
            setSetup(next)
            setSetupUnavailable(false)
          }
        })
        .catch(() => {
          if (active) setSetupUnavailable(true)
        })
        .finally(() => {
          polling = false
        })
    }, 1500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [connected, setup?.operation])

  /** Call a Studio capability through the host. @param name Fixed tool. @param args UI input. @returns Tool payload. */
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const app = appRef.current
    if (!app) throw new Error('Host unavailable.')
    const result = await app.callServerTool({ name, arguments: args })
    if (result.isError) throw new Error('Tool request failed.')
    return payload(result.structuredContent)
  }

  /** Serialize actions while allowing cancellation. @param action Pending action. @param work Work with freshness check. @param failure Safe recovery message. @returns Completion. */
  async function perform(
    action: Busy,
    work: (current: () => boolean) => Promise<void>,
    failure: string,
  ): Promise<void> {
    if (busyRef.current && action !== 'cancel') return
    const epoch = ++operation.current
    const current = () => alive.current && operation.current === epoch
    busyRef.current = action
    setBusy(action)
    setNotice('')
    setError('')
    try {
      await work(current)
    } catch {
      if (current()) setError(failure)
    } finally {
      if (current()) {
        busyRef.current = ''
        setBusy('')
      }
    }
  }

  workflow.configure({
    search: { approval: false, run: (input) => call('studio_search', input) },
    install: { approval: true, run: (input) => call('studio_install', input) },
  })

  /** Submit a real catalogue query. @param event Form submit. @returns Nothing. */
  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const term = query.trim()
    void perform(
      'search',
      async (current) => {
        const result = await workflow.invoke(
          'search',
          { query: term },
          'Search local facets',
          'Read the configured local catalogue.',
        )
        if (current()) {
          receiveSearch(result)
          setSearched(term)
        }
      },
      'Search could not finish. Check the connection and search again.',
    )
  }

  /** Install a returned identity without arbitrary sources. @param item Catalogue item. @returns Completion. */
  async function install(item: CatalogueItem): Promise<void> {
    await perform(
      'install',
      async (current) => {
        const outcome = await workflow.invoke(
          'install',
          { id: item.id },
          `Install ${item.name}?`,
          'This installs its packaged skills and app into the selected project. Approve to continue.',
        )
        if (outcome.declined) {
          if (current())
            setNotice('Installation declined. Nothing was installed.')
          return
        }
        const result = InstallSchema(outcome)
        if (
          result instanceof type.errors ||
          result.item.id !== item.id ||
          !result.item.installed
        )
          throw new Error('Invalid installation response.')
        if (current()) {
          await studioAgent.receive(
            {
              items: SearchSchema.assert(studioAgent.state).items.map(
                (entry) =>
                  entry.id === item.id
                    ? { ...result.item, openTool: result.app.openTool }
                    : entry,
              ),
              query: searched,
            },
            'studio_install',
          )
          setNotice(
            `${result.item.name} is installed. Open it in chat to begin.`,
          )
        }
      },
      'The facet could not be installed. Check CLI setup below, then retry Install facet.',
    )
  }

  /** Ask the host to render the installed app in its own card. @param item Installed item. @returns Completion. */
  async function open(item: CatalogueItem): Promise<void> {
    await perform(
      'open',
      async (current) => {
        if (
          !item.installed ||
          !item.openTool ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(item.openTool)
        )
          throw new Error('Missing installed app tool.')
        const result = await requestOpen(appRef.current!, {
          name: item.name,
          openTool: item.openTool,
        })
        if (result.isError) throw new Error('Host declined request.')
        if (current())
          setNotice(
            'Open request prepared. If it appears in your assistant’s composer, send it to open the installed app in chat.',
          )
      },
      'The assistant could not prepare the open request. Try Open in chat again.',
    )
  }

  /** Delegate setup and expose only validated status. @param action Setup action. @returns Completion. */
  async function setupAction(action: SetupAction): Promise<void> {
    const pending: Busy = action === 'install' ? 'setup-install' : action
    await perform(
      pending,
      async (current) => {
        const next = parseSetup((await call('studio_setup', { action })).setup)
        if (current()) {
          setSetup(next)
          setSetupUnavailable(false)
        }
      },
      'CLI setup could not finish. Retry the action or reopen Studio in your assistant.',
    )
  }

  const setupBusy =
    setup &&
    ['installing', 'starting-login', 'awaiting-login'].includes(setup.operation)
  const setupLabel =
    setup?.cli === 'ready'
      ? 'CLI ready'
      : setup?.cli === 'missing'
        ? 'CLI not installed'
        : 'Check CLI'
  return (
    <main className="studio-app" aria-label="Facet Studio discovery">
      <WorkflowTools workflow={workflow} />
      <header className="studio-header">
        <div className="studio-brand">
          Facet <span>Studio</span>
        </div>
        <span className="studio-local">Local catalogue</span>
      </header>
      <form className="studio-search" onSubmit={search}>
        <label htmlFor="studio-query">What would you like to do?</label>
        <div className="studio-search-row">
          <input
            id="studio-query"
            type="search"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a facet for meeting notes"
            disabled={!connected}
          />
          <button type="submit" disabled={!connected || Boolean(busy)}>
            {busy === 'search' ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      <section
        className="studio-results"
        aria-label="Matching facets"
        aria-busy={busy === 'search'}
      >
        {items === null && (
          <p className="studio-empty">
            {connected
              ? 'Search the local catalogue to find a facet for your task.'
              : 'Waiting for the assistant connection.'}
          </p>
        )}
        {items?.length === 0 && (
          <p className="studio-empty">
            No local facets match {searched ? `“${searched}”` : 'this search'}.
            Try a different task or keyword.
          </p>
        )}
        {items?.map((item) => (
          <article className="studio-result" key={item.id}>
            <h2>{item.name}</h2>
            <p>{item.description}</p>
            <div className="studio-result-footer">
              <span className="studio-meta">
                Local facet · v{item.version}
                {item.installed ? ' · Installed' : ''}
              </span>
              {item.installed ? (
                <button
                  type="button"
                  disabled={!connected || Boolean(busy) || !item.openTool}
                  onClick={() => void open(item)}
                >
                  {busy === 'open' ? 'Preparing…' : 'Open in chat'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!connected || Boolean(busy)}
                  onClick={() => void install(item)}
                >
                  {busy === 'install' ? 'Installing…' : 'Install facet'}
                </button>
              )}
            </div>
            {item.installed && !item.openTool && (
              <p className="studio-status">
                The installed app is unavailable. Search again to refresh its
                status.
              </p>
            )}
          </article>
        ))}
      </section>
      <p className="studio-status" role="status">
        {notice}
      </p>
      <p className="studio-status studio-error" role="alert">
        {error}
      </p>
      <details className="studio-setup">
        <summary>
          CLI setup <span>{setupLabel}</span>
        </summary>
        <p>
          {setupUnavailable
            ? 'Setup status is unavailable. Check again to retry.'
            : setup?.authentication === 'authenticated'
              ? 'Your Facet account is signed in.'
              : 'The Facet CLI handles installation and optional account sign-in.'}
        </p>
        {setup?.operation === 'failed' && (
          <p className="studio-error" role="alert">
            {setup.error === 'timeout'
              ? 'Setup timed out. Retry when you are ready.'
              : 'Setup did not complete. Check your connection and retry.'}
          </p>
        )}
        {setup?.operation === 'cancelled' && (
          <p>Setup cancelled. You can try again.</p>
        )}
        {setup?.verificationUrl && setup.userCode && (
          <div className="studio-login">
            <a href={setup.verificationUrl} target="_blank" rel="noreferrer">
              Continue to Facet sign-in
            </a>
            <strong className="studio-code">{setup.userCode}</strong>
            <span>Enter this code. Studio updates when sign-in completes.</span>
          </div>
        )}
        <div className="studio-setup-actions">
          {setup?.cli === 'missing' && (
            <button
              type="button"
              disabled={!connected || Boolean(busy) || Boolean(setupBusy)}
              onClick={() => void setupAction('install')}
            >
              {busy === 'setup-install'
                ? 'Installing CLI…'
                : 'Install Facet CLI'}
            </button>
          )}
          {setup?.cli === 'ready' &&
            setup.authentication !== 'authenticated' && (
              <button
                type="button"
                disabled={!connected || Boolean(busy) || Boolean(setupBusy)}
                onClick={() => void setupAction('login')}
              >
                {setupBusy || busy === 'login'
                  ? 'Waiting for sign-in…'
                  : 'Sign in'}
              </button>
            )}
          {(setupBusy || busy === 'setup-install' || busy === 'login') && (
            <button
              className="studio-secondary"
              type="button"
              disabled={busy === 'cancel'}
              onClick={() => void setupAction('cancel')}
            >
              Cancel setup
            </button>
          )}
          <button
            className="studio-secondary"
            type="button"
            disabled={!connected || Boolean(busy)}
            onClick={() => void setupAction('status')}
          >
            Check status
          </button>
        </div>
      </details>
    </main>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <WorkflowProvider core={studioCore}>
      <Studio />
    </WorkflowProvider>,
  )
