# Host setup

This skill carries `assets/server.js` and `assets/view.html`. Bun must be installed.

Run `bun <absolute-path-to-this-skill>/assets/server.js` as a stdio MCP server in a host that supports MCP Apps. Use an absolute path to the installed companion, not the source checkout. Ask the host to call `meeting_open`.

The example installer writes `claude-desktop.example.json` and `codex.example.toml` beside the consuming project's facets.json, with resolved paths. These are snippets to review and merge into your host's configuration. The installer does not modify desktop configuration globally. Restart or reconnect the host after configuration.

The browser preview is `bun <absolute-path-to-this-skill>/assets/server.js --browser`. The URL is printed to stderr. Host reasoning remains unavailable there.

Host support is capability-dependent. A successful stdio test establishes protocol behavior, not a verified desktop rendering result.
