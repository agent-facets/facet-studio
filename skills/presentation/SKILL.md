# Presentation

When presenting the result of a facet operation, use this contract for consistent markdown across all hosts.

## Result card format

Each result card opens with a header: `## <operation> — <facet name>`. Follow with a status line using Unicode marks (✓ for success, ✗ for error, ⚠ for warning), then a table summarizing assets. Column headers: Type | Name | Description. Use brand words for types: `skill`, `agent`, `command`, `server`.

## Error handling

Quote the CLI's own message verbatim in a fenced code block. Never paraphrase or simplify the error.

## Long output

If output exceeds 10 lines, show only the first 10 lines and note that full text is available on request.

## Routing rule

When `facet-studio` MCP tools are available in-session, use them—they return the same data plus branded panels where the host renders MCP Apps. Otherwise run the `facet` CLI per the using-facets skill. Output is identical in substance either way.

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

```
## facet build — my-skill

✗ Build failed.

```
error: plugin not found: nosuchplugin
```
```
