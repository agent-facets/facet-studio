---
method: dual-agent
score: 18
max: 40
timestamp: 2026-08-18T17-00-02Z
slug: hes-local-facet-studio-console-design-main-dc-html
---
Method: dual-agent (A: design-director review, opus→sonnet after two 529 failures · B: mechanical evidence, detector + hand-computed WCAG)

## Design Health Score

| Heuristic | Score |
| --- | --- |
| Visibility of system status | 2/4 |
| Match with the real world | 3/4 |
| User control and freedom | 1/4 |
| Consistency and standards | 2/4 |
| Error prevention | 1/4 |
| Recognition over recall | 3/4 |
| Flexibility and efficiency | 1/4 |
| Aesthetic and minimalist design | 3/4 |
| Diagnose and recover from errors | 1/4 |
| Help and documentation | 1/4 |
| **Total (at time of review)** | **18/40** |

## Design Specificity Verdict

Partially specific, unevenly. What earns it: the four-color asset taxonomy
(skill/agent/command/server) taken from ASSET_TYPE_COLORS, the proportional
composition stripe showing a bundle's mix before you read prose, and copy only this
product would write ("Install writes to facets.json and facets.lock", "A materialized
file drifted from the lockfile"). What was generic: Detail's tab bar, Author's field
grid and Installed's row list are shapes every package manager shares, and the serif
wordmark appeared only on Gallery, so brand presence dropped on the three screens where
a user most needs to know they are still in the same tool.

## Verdict on the central question

Gallery alone created desire. The other three were static mockups wearing
clickable-looking chrome, which is a worse trust position than a plain table: a table
never promises a click it does not deliver.

## Confirmed defects, both methods agreeing

Contrast: INK_DARK.inkFaint (#6a6890) as body text measured 3.75:1 on bg and 3.53:1 on
the card surface against a 4.5:1 requirement. Found by hand and independently by the
detector's computed check (3.8:1). Systemic across all four files.

The detector initially ran DEGRADED with its HTML parser modules missing, so its silence
on contrast meant nothing. Installing htmlparser2, css-select, css-tree and domutils
turned up a category the regex fallback could not see: undersized-ui-text at 10.5px and
an 11px body-text floor breach.

Type scale: eight sizes inside a 6.5px band. This is the same defect as the operator's
"looks like a table" complaint — uniform type is what a table is.

## Fixes applied

- Every content-bearing text colour moved to inkDim (#a8a6c4), 7.87:1 on card
- Type ramp rebuilt at 12 / 15 / 19 / 24px, each step ~1.25x
- #c4b5fd replaced with PALETTE.violet400 (#a78bfa); it was Tailwind violet-300, not a
  brand token. Line colour 0.17 corrected to LINE_DARK.lineStrong 0.16
- Small violet text moved off ACCENTS_DARK.violet, which fails at 4.38:1 on card
- Clickable spans became real buttons; :focus-visible ring on the brand focus colour
- Composition stripes got role="img" and a text summary, so the colour is no longer the
  only channel; decorative dots marked aria-hidden
- Publish gated on verify passing, since a published version can never be replaced
- Installed's Update, Remove (confirm plus undo) and Repair now work; Detail's tabs
  switch and gate content; Author's Verify drives real state
- Removed a dead-end promise ("7 more on the next page") with no pagination behind it;
  added the missing servers filter and an empty state
- prefers-reduced-motion honoured on every animation

Detector: 10 findings to 0. Every remaining colour literal is a verified brand token.

## Open, not addressed

- No changelog or diff before an update, which is what the audit-minded persona wants
- No first-run legend for the colour taxonomy or terms like "lockfile drift"
- Author's fields are read-only spans, so it reads as a status dashboard rather than the
  editor its title promises
- Detail has no working way back; its real entry point is undecided

## Upstream

Filed brand-light-accents-fail-contrast: the brand's light-theme accents fail AA as
text (amber 2.67:1, green 1.81:1, coral 2.09:1), so the panel deliberately commits to
one dark surface instead of adopting the host's light theme.
