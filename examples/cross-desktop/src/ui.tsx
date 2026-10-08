/**
 * DIRECTION: Extend Studio's dark purple workspace with a staged Operate walkthrough.
 * FIRST VIEWPORT: A quiet setup rail beside a useful meeting worksheet; notes lead to editable actions.
 * SIGNATURE: The same worksheet receives a host proposal through AG-UI without losing its source notes.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAgent } from '@copilotkit/react-core/v2/headless'
import {
  CopilotKitContext,
  CopilotKitCoreReact,
} from '@copilotkit/react-core/v2/context'
import { MeetingAgent } from './agent'
import {
  connectBridge,
  parseSetup,
  type Bridge,
  type SetupStatus,
} from './bridge'
import {
  emptyPlan,
  editPlan,
  markdown,
  parsePlan,
  samplePlan,
  type Plan,
} from './model'
import './style.css'

const meetingAgent = new MeetingAgent()
const copilotkit = new CopilotKitCoreReact({
  agents__unsafe_dev_only: { meeting: meetingAgent },
})
const copilotContext = {
  copilotkit,
  executingToolCallIds: new Set<string>(),
  showIntelligenceIndicator: false,
}

/** Render the shared staged worksheet. @returns Accessible facet workspace. */
function Workspace() {
  const { agent } = useAgent({ agentId: 'meeting' })
  const plan = parsePlan(agent.state)
  const [bridge, setBridge] = useState<Bridge>()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [setup, setSetup] = useState<SetupStatus>()
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    let active = true
    void connectBridge(
      meetingAgent,
      (value) => {
        if (active) {
          setBridge(value)
          if (value.installed) {
            setInstalled(true)
            setStep((current) => (current === 0 ? 1 : current))
          }
        }
      },
      setNotice,
      () => {
        if (active) setStep(2)
      },
    )
      .then(async (value) => {
        if (value.connected) return
        const result = await value.call('meeting_open')
        if (active) await meetingAgent.accept(result.plan)
      })
      .catch(() =>
        setNotice(
          'The assistant connection could not open. Reopen this tool in an MCP Apps host.',
        ),
      )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!bridge) return
    /** Refresh CLI status without starting authentication. @returns Completion. */
    async function refresh() {
      try {
        const result = await bridge!.call('facet_setup', { action: 'status' })
        setSetup(parseSetup(result.setup))
      } catch {
        setNotice(
          'Setup status is unavailable. Check that the local server is running.',
        )
      }
    }
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [bridge])

  /** Report asynchronous action progress. @param label Activity label. @param action Work. @returns Completion. */
  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label)
    setNotice('')
    try {
      await action()
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'The action failed. Try again.',
      )
    } finally {
      setBusy('')
    }
  }

  /** Update CopilotKit state as the user edits. @param patch Changed fields. @returns Nothing. */
  function edit(patch: Partial<Plan>) {
    agent.setState(editPlan(plan, patch))
  }

  /** Delegate setup to the CLI-owned service. @param action Explicit setup intent. @returns Completion. */
  async function setupAction(action: string) {
    if (!bridge) return
    const result = await bridge.call('facet_setup', { action })
    setSetup(parseSetup(result.setup))
  }

  /** Save the reviewed plan through the active transport. @returns Completion. */
  async function save() {
    if (!bridge) return
    const result = await bridge.call('meeting_plan', { plan })
    await meetingAgent.accept(result.plan)
    setNotice('Plan saved for this server session.')
  }

  /** Download an editable Markdown artifact. @returns Nothing. */
  function download() {
    const url = URL.createObjectURL(
      new Blob([markdown(plan)], { type: 'text/markdown;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'meeting-actions.md'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <main>
      <header>
        <a className="brand" href="#">
          facet<span>studio</span>
        </a>
        <button
          className="quiet"
          onClick={() => {
            document.documentElement.dataset.theme =
              document.documentElement.dataset.theme === 'light'
                ? 'dark'
                : 'light'
          }}
        >
          Switch theme
        </button>
      </header>
      <div className="workspace">
        <aside>
          <h1>
            Meeting <br />
            to Action
          </h1>
          <p>Turn the conversation into a plan you can use.</p>
          <nav aria-label="Walkthrough">
            {[
              'Set up your facet',
              'Capture the meeting',
              'Review & export',
            ].map((label, index) => (
              <button
                key={label}
                aria-current={step === index ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span>{index + 1}</span>
                {label}
              </button>
            ))}
          </nav>
          <div className="connection">
            <span className={bridge?.connected ? 'live' : 'sample'} />
            {bridge?.connected
              ? 'Connected to your assistant'
              : 'Browser preview · no host reasoning'}
            <p>
              {bridge?.connected
                ? 'Your assistant proposes. You review.'
                : 'Use the sample or write a plan yourself. AI requests require an MCP Apps host.'}
            </p>
          </div>
        </aside>
        <section className="sheet" aria-busy={Boolean(busy)}>
          {step === 0 && (
            <>
              <h2>
                A small facet.
                <br />A complete workflow.
              </h2>
              <p className="intro">
                Install the skill, its visual worksheet, and its local server
                together. Your assistant brings the reasoning.
              </p>
              <dl className="details">
                <div>
                  <dt>Included</dt>
                  <dd>Meeting skill · editable worksheet · MCP server</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>0.1.0 · local example</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>Bun · already running</dd>
                </div>
                <div>
                  <dt>Facet CLI</dt>
                  <dd>
                    {setup?.cli === 'ready'
                      ? 'Ready'
                      : setup?.cli === 'missing'
                        ? 'Not installed'
                        : 'Checking…'}
                  </dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>{setup?.authentication ?? 'Checking…'}</dd>
                </div>
              </dl>
              <div className="actions">
                {setup?.cli === 'missing' && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void perform('Installing CLI…', () =>
                        setupAction('install'),
                      )
                    }
                  >
                    Install Facet CLI
                  </button>
                )}
                {setup?.cli === 'ready' &&
                  setup.authentication !== 'authenticated' && (
                    <button
                      disabled={!!busy || setup.operation === 'awaiting-login'}
                      onClick={() =>
                        void perform('Starting sign in…', () =>
                          setupAction('login'),
                        )
                      }
                    >
                      Sign in with Facet
                    </button>
                  )}
                <button
                  disabled={!!busy || setup?.cli !== 'ready'}
                  onClick={() =>
                    void perform('Installing facet…', async () => {
                      await bridge!.call('facet_install')
                      setInstalled(true)
                      setNotice(
                        'Facet installed into the local example project.',
                      )
                    })
                  }
                >
                  {installed ? 'Reinstall example' : 'Install this facet'}
                </button>
              </div>
              {setup?.verificationUrl && (
                <div className="login">
                  <h3>Complete sign in</h3>
                  <p>
                    Open{' '}
                    <a
                      href={setup.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Facet device authorization
                    </a>{' '}
                    and enter <strong>{setup.userCode}</strong>.
                  </p>
                  <button
                    className="quiet"
                    onClick={() =>
                      void perform('Cancelling…', () => setupAction('cancel'))
                    }
                  >
                    Cancel sign in
                  </button>
                </div>
              )}
              {setup?.error && (
                <p role="alert">
                  Setup could not finish ({setup.error}). Try again.
                </p>
              )}
              <footer>
                <span>Local installation stays on this computer.</span>
                <button onClick={() => setStep(1)}>Continue to meeting</button>
              </footer>
            </>
          )}
          {step === 1 && (
            <>
              <h2>Start with what was said.</h2>
              <p className="intro">
                Paste the meeting notes. Keep uncertainty in the source; review
                the proposal before sharing.
              </p>
              <label>
                Meeting title
                <input
                  value={plan.title}
                  maxLength={200}
                  onChange={(event) => edit({ title: event.target.value })}
                />
              </label>
              <label>
                Source notes
                <textarea
                  rows={12}
                  placeholder="Decisions, questions, follow-ups, and who agreed to do what…"
                  maxLength={30000}
                  value={plan.notes}
                  onChange={(event) => edit({ notes: event.target.value })}
                />
              </label>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() =>
                    void perform('Loading sample…', async () => {
                      await meetingAgent.accept(samplePlan)
                      setNotice('Illustrative sample loaded. No AI was used.')
                    })
                  }
                >
                  Use sample meeting
                </button>
                <button
                  disabled={!!busy || !bridge?.connected || !plan.notes.trim()}
                  onClick={() =>
                    void perform('Sending to assistant…', async () => {
                      await bridge!.request(plan)
                      setNotice(
                        'Sent to your assistant. Continue in the conversation; open the updated worksheet returned by your assistant.',
                      )
                      setStep(2)
                    })
                  }
                >
                  Ask assistant for a plan
                </button>
              </div>
              <footer>
                <span>
                  {plan.source === 'sample'
                    ? 'Illustrative sample'
                    : 'Your source notes'}
                </span>
                <button className="quiet" onClick={() => setStep(2)}>
                  Review worksheet
                </button>
              </footer>
            </>
          )}
          {step === 2 && (
            <>
              <div className="sheet-heading">
                <div>
                  <h2>{plan.title}</h2>
                  <p>
                    {plan.source === 'host'
                      ? 'Assistant proposal · review before sharing'
                      : plan.source === 'sample'
                        ? plan.edited
                          ? 'Edited sample · no AI used'
                          : 'Illustrative sample · no AI used'
                        : 'Your editable worksheet'}
                  </p>
                </div>
                <button className="quiet" onClick={() => setStep(1)}>
                  Edit notes
                </button>
              </div>
              <label>
                Decisions
                <textarea
                  rows={3}
                  value={plan.decisions}
                  maxLength={10000}
                  placeholder="Record the decisions the meeting reached."
                  onChange={(event) => edit({ decisions: event.target.value })}
                />
              </label>
              <h3>Actions</h3>
              {plan.actions.length === 0 && (
                <p className="empty">
                  No actions yet. Ask your assistant from the notes step, load a
                  sample, or add an action below.
                </p>
              )}
              <div className="action-list">
                {plan.actions.map((action, index) => (
                  <div className="action-row" key={action.id}>
                    <input
                      aria-label={`Complete action ${index + 1}`}
                      type="checkbox"
                      checked={action.done}
                      onChange={(event) =>
                        edit({
                          actions: plan.actions.map((item) =>
                            item.id === action.id
                              ? { ...item, done: event.target.checked }
                              : item,
                          ),
                        })
                      }
                    />
                    <div>
                      <label>
                        Action {index + 1}
                        <input
                          value={action.task}
                          maxLength={2000}
                          onChange={(event) =>
                            edit({
                              actions: plan.actions.map((item) =>
                                item.id === action.id
                                  ? { ...item, task: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                      <div className="assignment">
                        <label>
                          Owner
                          <input
                            placeholder="Unassigned"
                            value={action.owner}
                            maxLength={200}
                            onChange={(event) =>
                              edit({
                                actions: plan.actions.map((item) =>
                                  item.id === action.id
                                    ? { ...item, owner: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Due date
                          <input
                            type="date"
                            value={action.due}
                            onChange={(event) =>
                              edit({
                                actions: plan.actions.map((item) =>
                                  item.id === action.id
                                    ? { ...item, due: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                      </div>
                    </div>
                    <button
                      className="quiet remove"
                      aria-label={`Remove action ${index + 1}`}
                      onClick={() =>
                        edit({
                          actions: plan.actions.filter(
                            (item) => item.id !== action.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="secondary"
                disabled={plan.actions.length >= 100}
                onClick={() =>
                  edit({
                    actions: [
                      ...plan.actions,
                      {
                        id: crypto.randomUUID(),
                        task: '',
                        owner: '',
                        due: '',
                        done: false,
                      },
                    ],
                  })
                }
              >
                Add action
              </button>
              <details>
                <summary>Source notes</summary>
                <p className="source-notes">
                  {plan.notes || 'No source notes recorded.'}
                </p>
              </details>
              <footer>
                <button
                  className="secondary"
                  disabled={!!busy || !bridge}
                  onClick={() => void perform('Saving…', save)}
                >
                  Save plan
                </button>
                <button onClick={download}>Export Markdown</button>
              </footer>
            </>
          )}
          <div className="status" role="status" aria-live="polite">
            {busy || notice}
          </div>
        </section>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <CopilotKitContext.Provider value={copilotContext}>
    <Workspace />
  </CopilotKitContext.Provider>,
)
