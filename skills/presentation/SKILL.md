# Presentation

When presenting the result of a facet operation, use this contract for consistent markdown across all hosts.

**First, check whether there is anything to present at all.** Where the host draws
the Facet Studio panel, a read — browse, detail, readme, project, manifest — is
answered by the screen, and you write nothing under it: no summary, no result
card, no list of what came back, no `facet ...` command for something the panel's
own buttons do. The card format below is for text-only hosts, and for operation
outcomes that a strip reports rather than a screen. When in doubt about a read on
a panel host, the answer is silence.

## Result card format

Each result card opens with a header: `## <operation> — <facet name>`. Follow with a status line using Unicode marks (✓ for success, ✗ for error, ⚠ for warning), then a table summarizing assets. Column headers: Type | Name | Description. Use brand words for types: `skill`, `agent`, `command`, `server`.

## Error handling

Quote the CLI's own message verbatim in a fenced code block. Never paraphrase or simplify the error.

## Long output

If output exceeds 10 lines, show only the first 10 lines and note that full text is available on request.

## Routing rule

When `facet-studio` MCP tools are available in-session, use them—they return the same data plus the console panel where the host renders MCP Apps. Otherwise run the `facet` CLI per the using-facets skill. Output is identical in substance either way.

## The console

Where a host renders MCP Apps, every facet tool points at one panel, and that panel is a console with three screens rather than a card per call:

| Screen | Shows | Filled by |
|---|---|---|
| Registry | What is published, with an Install on each card | `facet_browse` for discovery; `facet_detail` when opening one facet |
| Installed | What this project has, with Update, Remove and Repair | `facet_project` |
| Authoring | The facet being written, with its fields and assets editable | `facet_manifest` |

Two consequences for how results are described in prose:

- A **read** is answered by its screen. Say what was found; do not also narrate that a panel opened.
- An **operation** — add, remove, update, install, modify, build, verify — puts its outcome on a strip above the screen, and the screen is re-read so it shows the state the operation produced. Describe the outcome in the CLI's own words, as a result card, exactly as if there were no panel.

Publishing has no MCP tool. Direct people to `facet publish` or the `/facet-publish` command, and never imply the panel can publish.

## Discovery is one call

A question about what facets exist, what they do, or which are worth installing is answered by ONE `facet_browse` call, searched for what the user actually asked about. Pull the subject out of their question and pass it as `query`—one or two keywords, space separated. "What facets help with my git workflows" is a search for `git worktree`. Each keyword is searched separately and the results merged, so a second one only ever adds matches; keep them to subject words a facet's name or description would use and drop filler like "facets" or "help". Keywords that match nothing fall back to the whole catalog on their own, so a broad question is never a reason to drop the query. Do not follow the call with `facet_detail`, `facet_contents`, or `facet_project`—the browse result already carries each facet's description, asset counts, and install state. The panel handles pagination itself; row click opens detail and Install/Update act in place. For `facet_contents`, `facet_readme`, and `facet_update`, a `version` argument is optional and defaults to the latest published release when omitted.

Where the panel renders, that panel is the whole answer: say nothing after it. No prose summary, no bulleted list of the results, no "here are the ones that fit", no offer to install. The user is already reading the rows and can search, page, open, and install without a sentence from you. Which results fit is a question the panel answers too. Speak only for something the panel cannot show, and then in one short sentence.

## Host matrix

| Host | Apps panels | Markdown |
|------|---|---|
| Claude Desktop (Chat) | ✓ | ✓ |
| Claude Desktop (Code tab) | — | ✓ |
| ChatGPT | ✓ | ✓ |
| Cursor | ✓ | ✓ |
| Claude Code CLI | — | ✓ |
| Codex | — | ✓ |

## Example: success card

```
## facet build — my-skill

✓ Build succeeded.

| Type | Name | Description |
|---|---|---|
| skill | my-skill | Sample skill |
| command | build | Compiles skill |
```

## Example: error card

`````
## facet build — my-skill

✗ Build failed.

```
error: plugin not found: nosuchplugin
```
`````
