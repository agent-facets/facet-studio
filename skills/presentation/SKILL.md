# Presentation

When presenting the result of a facet operation, use this contract for consistent markdown across all hosts.

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
| Registry | What is published, with an Install on each card | `facet_browse`, and `facet_detail` for one facet |
| Installed | What this project has, with Update, Remove and Repair | `facet_project` |
| Authoring | The facet being written, with its fields and assets editable | `facet_manifest` |

Two consequences for how results are described in prose:

- A **read** is answered by its screen. Say what was found; do not also narrate that a panel opened.
- An **operation** — add, remove, update, install, modify, build, verify — puts its outcome on a strip above the screen, and the screen is re-read so it shows the state the operation produced. Describe the outcome in the CLI's own words, as a result card, exactly as if there were no panel.

Publishing has no MCP tool. Direct people to `facet publish` or the `/facet-publish` command, and never imply the panel can publish.

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
