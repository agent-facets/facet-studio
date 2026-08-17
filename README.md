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

Skills and commands materialize into `.agents/`, and agents into `.codex/agents/*.toml`.

## Development

The development loop for facet-studio:

```bash
facet modify         # Edit a skill, agent, or command
facet build --verify # Validate and build
bun scripts/build-plugin.ts  # Build the plugin
bash scripts/verify-install.sh  # Verify installation
```

## Generated Plugin Directory

The `plugin/` directory is generated during the build process. Do not edit files in `plugin/` by hand — they will be overwritten.
