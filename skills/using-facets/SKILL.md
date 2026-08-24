# Using Facets

Facets are portable bundles of skills, agents, and commands for AI coding tools.
They are managed exclusively by the `facet` CLI. Whenever you are about to
create, edit, build, publish, add, update, or remove a facet—or answer a
question about how facets work—do NOT improvise. Route the work through the
CLI, which ships its own agent-facing instructions.

## Check the CLI and run instructions

Start by verifying the CLI is installed and current:

```sh
facet --version
```

- **Exit code 0 and version ≥ 0.24.0** → continue to "Read CLI instructions" below.
- **Exit code 0 but version < 0.24.0** → continue to "Update the CLI" below.
- **Command not found / non-zero exit** → continue to "Install the CLI" below.

### Install the CLI

Ask the user whether they want to install the CLI using a binary choice:

- **Install the facet CLI** — you run the installer, then continue.
- **Don't install** — stop the task and tell the user nothing was changed.

If the user chooses to install, run:

```sh
curl -fsSL https://agentfacets.io/install | bash
```

Alternates: `npm install -g agent-facets` or `bun add -g agent-facets`.

Then re-run `facet --version` to confirm, and continue to "Read CLI instructions" below.

### Update the CLI

If the installed version is below 0.24.0, run:

```sh
facet self-update
```

Use `--version <x.y.z>` to pick a specific release, or `--dry-run` to preview.
Then continue to "Read CLI instructions" below.

### Read CLI instructions, then act

The CLI is the source of truth for its own workflow. Never hand-write `facet.json`,
`facets.json`, or `facets.lock` from memory. Get current guidance straight from the tool:

```sh
facet instructions
```

That prints an overview and a topic index. Read the topic that matches the task
**before** running any mutating command:

- **Authoring** a facet (writing/changing its `facet.json` and files):
  ```sh
  facet instructions authoring
  ```
- **Using** facets in a project (adding, updating, removing facets; installing adapters):
  ```sh
  facet instructions usage
  ```
- **Manifest** structure and JSON Schema for `facet.json`:
  ```sh
  facet instructions manifest
  ```

Follow the printed instructions. Prefer `--json` on `facet create`, `facet modify`,
and `facet build` when you need to parse results. Always finish authoring with
`facet build --verify`.

## MCP Server Routing

When the facet-studio MCP server is connected, prefer its `facet_*` tools over raw CLI calls — same operations, structured results, branded panels where the host renders them; load the `presentation` skill for output formatting. The CLI path below remains the fallback.

### Discovery routing

Questions about what facets exist, what they do, or which to install route to one `facet_browse` call—never a browse-then-detail chain, and never the CLI's `facet search` when the MCP server is connected. The browse result already answers the question.

## Headless environments

In CI or sandboxes without a TTY:

- `facet add` requires an installed adapter (e.g., `claude-code`). Pre-install:
  ```sh
  facet adapter add claude-code
  ```
- `facet install` with `--frozen-lockfile` never prompts.
- `facet login` is interactive-only. Use `FACET_TOKEN=fct_pub_…` environment variable instead.
