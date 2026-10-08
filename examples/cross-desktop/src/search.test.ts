import { expect, test } from 'bun:test'
import { contextQuery, matchesIntent } from './search'
import manifest from '../facet/facet.json'

test('natural task intent matches words and synonyms without conversational filler', () => {
  for (const query of [
    'Can you help me organize my meeting notes?',
    'meeting notes actions',
    'meeting minutes follow-ups',
    'follow-ups',
    'owners dates decisions',
    'action items meeting',
    'meeting notes workflow',
    'meeting action plan',
  ])
    expect(matchesIntent(manifest, query)).toBe(true)
  expect(matchesIntent(manifest, 'research customer interviews')).toBe(false)
  expect(matchesIntent(manifest, 'meeting astronomy')).toBe(false)
  expect(matchesIntent(manifest, 'organize')).toBe(false)
  expect(matchesIntent(manifest, '')).toBe(true)
})

test('initial query context preserves host wording for input and result prefill', () => {
  const query = 'meeting notes actions'
  expect(contextQuery({ query })).toBe(query)
  expect(contextQuery({ items: [], query })).toBe(query)
  expect(contextQuery({ items: [] })).toBeUndefined()
  expect(contextQuery({ query: 123 })).toBeUndefined()
  expect(contextQuery({ query: 'x'.repeat(201) })).toBeUndefined()
})
