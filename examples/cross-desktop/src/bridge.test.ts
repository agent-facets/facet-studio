import { expect, test } from 'bun:test'
import { MeetingAgent } from './agent'
import { planRequest, receiveHostPlan } from './bridge'
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
