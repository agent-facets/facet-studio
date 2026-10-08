import { type } from 'arktype'

const QueryContext = type({ 'query?': 'string <= 200' })
const filler = new Set([
  'a',
  'an',
  'and',
  'can',
  'for',
  'help',
  'i',
  'in',
  'me',
  'my',
  'of',
  'organise',
  'organize',
  'please',
  'the',
  'to',
  'up',
  'ups',
  'with',
  'you',
])
const synonyms: Record<string, string> = {
  minutes: 'note',
  minute: 'note',
  notes: 'note',
  actions: 'action',
  tasks: 'action',
  task: 'action',
  followup: 'action',
  followups: 'action',
  follow: 'action',
  owners: 'owner',
  dates: 'date',
  decisions: 'decision',
}

/** Normalize task keywords while ignoring conversational filler. @param value Search text. @returns Unique matching terms. */
function terms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word && !filler.has(word))
        .map((word) => synonyms[word] ?? word),
    ),
  ]
}

/** Match meaningful intent terms independently of phrase order. @param entry Local catalogue metadata. @param query Host- or user-supplied keywords. @returns Whether the entry matches at least two thirds of meaningful terms. */
export function matchesIntent(
  entry: { name: string; description: string },
  query: string,
): boolean {
  if (!query.trim()) return true
  const requested = terms(query)
  if (requested.length === 0) return false
  const available = new Set(terms(`${entry.name} ${entry.description}`))
  const matched = requested.filter((word) => available.has(word)).length
  return matched * 3 >= requested.length * 2
}

/** Carry a bounded host query into the initial search field without changing its wording. @param value Tool input or result envelope. @returns Query for prefill when valid. */
export function contextQuery(value: unknown): string | undefined {
  const parsed = QueryContext(value)
  return parsed instanceof type.errors ? undefined : parsed.query
}
