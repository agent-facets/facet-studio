import { expect, test } from 'bun:test'
import { MeetingAgent } from './agent'
import { editPlan, markdown, parsePlan, samplePlan } from './model'
import { handleRequest } from './server'

test('host snapshots update AG-UI state and reject invalid inputs', async () => {
  const agent = new MeetingAgent()
  await agent.accept({ ...samplePlan, source: 'host' })
  expect(agent.state.actions).toHaveLength(2)
  expect(agent.state.source).toBe('host')
  expect(() =>
    parsePlan({ ...samplePlan, actions: [{ task: 'Incomplete' }] }),
  ).toThrow()
  expect(() => parsePlan({ ...samplePlan, notes: 'x'.repeat(30001) })).toThrow()
})

test('export preserves edits and unset assignments', () => {
  const plan = parsePlan({
    ...samplePlan,
    actions: [
      { id: 'one', task: 'Review notes', owner: '', due: '', done: true },
    ],
  })
  expect(markdown(plan)).toContain('- [x] Review notes · Unassigned · No date')
  expect(markdown(plan)).toContain(plan.notes)
})

test('browser rejects cross-origin mutation and unknown capabilities', async () => {
  expect(
    (
      await handleRequest(
        new Request('http://127.0.0.1:4328/api/tool', {
          method: 'POST',
          headers: {
            Origin: 'https://untrusted.example',
            'Content-Type': 'application/json',
          },
          body: '{"name":"facet_install"}',
        }),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await handleRequest(
        new Request('http://evil.example/api/tool', { method: 'POST' }),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await handleRequest(
        new Request('http://127.0.0.1:4328/api/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"run_shell"}',
        }),
      )
    ).status,
  ).toBe(400)
})

test('editing a sample preserves provenance through validation and export state', () => {
  const edited = parsePlan(editPlan(samplePlan, { title: 'Edited example' }))
  expect(edited.source).toBe('sample')
  expect(edited.edited).toBe(true)
  expect(edited.title).toBe('Edited example')
})

test('due dates must exist in the calendar, including leap days', () => {
  for (const due of ['2026-99-99', '2026-02-29', '2026-04-31', '0000-01-01']) {
    expect(() =>
      parsePlan({
        ...samplePlan,
        actions: [{ ...samplePlan.actions[0]!, due }],
      }),
    ).toThrow()
  }
  for (const due of ['', '2028-02-29', '2026-04-30']) {
    expect(
      parsePlan({
        ...samplePlan,
        actions: [{ ...samplePlan.actions[0]!, due }],
      }).actions[0]?.due,
    ).toBe(due)
  }
})
