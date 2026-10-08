import { configure, type } from 'arktype'

// MCP Apps may disallow dynamic code generation.
configure({ jitless: true })

export const PlanSchema = type({
  title: 'string <= 200',
  notes: 'string <= 30000',
  decisions: 'string <= 10000',
  actions: type({
    id: 'string <= 80',
    task: 'string <= 2000',
    owner: 'string <= 200',
    due: 'string <= 10',
    done: 'boolean',
  })
    .array()
    .atMostLength(100),
  source: "'empty' | 'sample' | 'host' | 'edited'",
  'edited?': 'boolean',
})
export type Plan = typeof PlanSchema.infer
export const emptyPlan: Plan = {
  title: 'Meeting to Action',
  notes: '',
  decisions: '',
  actions: [],
  source: 'empty',
}
export const samplePlan: Plan = {
  title: 'Launch readiness',
  source: 'sample',
  notes:
    'Sample meeting · Thursday\nMaya will confirm the onboarding copy by Friday. Leo will check keyboard navigation before release. We agreed to launch the small pilot first and review feedback next week.',
  decisions: 'Launch a small pilot first.\nReview pilot feedback next week.',
  actions: [
    {
      id: 'copy',
      task: 'Confirm onboarding copy',
      owner: 'Maya',
      due: '',
      done: false,
    },
    {
      id: 'access',
      task: 'Check keyboard navigation before release',
      owner: 'Leo',
      due: '',
      done: false,
    },
  ],
}

/** Validate an untrusted plan. @param value Boundary value. @returns Valid plan or a safe validation error. */
export function parsePlan(value: unknown): Plan {
  const result = PlanSchema(value)
  if (result instanceof type.errors)
    throw new Error(
      'The plan format is invalid. Check the meeting fields and try again.',
    )
  if (
    new Set(result.actions.map((action) => action.id)).size !==
    result.actions.length
  )
    throw new Error('Each action needs a unique ID.')
  if (result.actions.some((action) => !validDueDate(action.due)))
    throw new Error(
      'Use a valid calendar date in YYYY-MM-DD format or leave it empty.',
    )
  return result
}

/** Export user-reviewed content. @param plan Current plan. @returns Portable Markdown. */
export function markdown(plan: Plan): string {
  return `# ${plan.title}\n\n## Decisions\n${plan.decisions || 'No decisions recorded.'}\n\n## Actions\n${plan.actions.map((action) => `- [${action.done ? 'x' : ' '}] ${action.task} · ${action.owner || 'Unassigned'} · ${action.due || 'No date'}`).join('\n') || 'No actions recorded.'}\n\n## Source notes\n${plan.notes}\n`
}

/** Preserve provenance while applying user edits. @param plan Current worksheet. @param patch Changed fields. @returns Edited worksheet with its original source. */
export function editPlan(plan: Plan, patch: Partial<Plan>): Plan {
  return {
    ...plan,
    ...patch,
    source: plan.source === 'empty' ? 'edited' : plan.source,
    edited: true,
  }
}

/** Check date-only values without timezone shifts. @param value Optional due date. @returns Whether the calendar date exists. */
function validDueDate(value: string): boolean {
  if (value === '') return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-'))
    return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}
