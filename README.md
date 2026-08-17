# facet-studio

facet-studio is a toolkit for authoring, building, and installing agent facets — reusable collections of skills and commands for AI assistants. It includes skills and commands that guide you through the full facet workflow.

## Assets

| Type | Name | Purpose |
|------|------|---------|
| Skill | using-facets | Ensures the facet CLI is installed and current, then routes facet operations through facet instructions. |
| Skill | authoring | Guidelines for authoring facet assets: naming conventions, metadata, adapter config, and content standards. |
| Agent | facet-author | Headless facet authoring agent that handles scaffolding, asset content, metadata, build, verify, and publish. |
| Command | facet-create | Scaffold a new facet project. |
| Command | facet-modify | Edit a facet asset or metadata. |
| Command | facet-build | Validate and build the distributable archive. |
| Command | facet-publish | Publish the facet to the registry. |
| Command | facet-add | Add and install one or more facets. |
| Command | facet-update | Update installed facets. |
| Command | facet-remove | Remove facets. |
| Command | facet-list | List installed facets. |

## Branded panels and the MCP server

facet-studio ships with an MCP server that adds structured panels and rich context to compatible hosts. Panels render natively in Claude Desktop, ChatGPT, and Cursor; Claude Code CLI is terminal-only and returns full text output. Codex Desktop does not render panels yet (upstream bug tracked). Every operation returns complete text regardless—panels are an enhancement, not a requirement.

The server bundles inside the Claude plugin:

| Host | Panels | Support |
|------|--------|---------|
| Claude Desktop | Yes | Connector-enabled |
| ChatGPT | Yes | Connector-enabled |
| Cursor | Yes | MCP-enabled |
| Claude Code CLI | No | Terminal only |
| Codex Desktop | No | Pending upstream |

## Installation

### Claude Code / Claude Desktop

To install facet-studio in Claude Code or Claude Desktop:

```bash
/plugin marketplace add <path-or-repo>
/plugin install facet-studio@facet-studio
```

For local development without installation:

```bash
claude --plugin-dir ./plugin
```

Desktop app cowork sessions load plugins from claude.ai, not local directories.

### Sign in to the registry

Use `facet_login` to sign in with Google (or GitHub when the registry launches). It stores your authentication token locally for CLI use. If your environment doesn't support a browser-based flow, `facet_login` walks you through creating a personal token instead. Non-interactive environments (CI, containers) use the `FACET_TOKEN` environment variable.

### Facet Projects

Once facet-studio is published to the registry, install it in any facet project:

```bash
facet add facet-studio
```

Until published, add the local path:

```bash
facet add <path-to-this-repo>
```

### Codex

To use facet-studio with Codex, enable the Codex adapter:

```bash
facet adapter add codex
facet add facet-studio
```

This materializes skills into `.agents/skills/` (scanned by Codex) and the custom `facet-author` agent into `.codex/agents/*.toml`. The eight facet-* command workflows are not invocable in Codex sessions today; an upstream adapter fix is tracked in the facets repo. To author and manage facets in Codex, use the `using-facets` and `authoring` skills plus the `facet-author` agent—this route is facet-CLI materialization into local directories, not a Codex-native plugin (Codex's plugin system uses `.codex-plugin/plugin.json`).

The MCP server does not install automatically for Codex in this iteration. To add it, clone this repo, build the plugin, and add this to `~/.codex/config.toml` (this is a manual step; a facet-carried install is planned):

```toml
[mcp_servers.facet-studio]
command = "node"
args = ["/absolute/path/to/facet-studio/plugin/mcp/server.mjs"]
```

Run `bun scripts/build-plugin.ts` in the repo root to generate the server file.

## Development

The development loop for facet-studio:

```bash
facet modify         # Edit a skill, agent, or command
facet build --verify # Validate and build
bun scripts/build-plugin.ts  # Build the plugin
bash scripts/verify-install.sh  # Verify installation
cd mcp && bun test   # Test the MCP server
```

## Generated Plugin Directory

The `plugin/` directory is generated during the build process. Do not edit files in `plugin/` by hand — they will be overwritten.
