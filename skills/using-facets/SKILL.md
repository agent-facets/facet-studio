# Using Facets

Facets are portable bundles of skills, agents, and commands for AI coding tools.
They are managed exclusively by the `facet` CLI. Whenever you are about to
create, edit, build, publish, add, update, or remove a facet—or answer a
question about how facets work—do NOT improvise. Route the work through the
CLI, which ships its own agent-facing instructions.

## Step 1 — Check for the CLI

Run:

```sh
facet --version
```

- **Exit code 0 (a version prints)** → the CLI is installed. Go to Step 2.
- **Command not found / non-zero exit** → the CLI is not installed. Go to "CLI not installed" below.

## Step 2 — Read the CLI's own instructions, then act

The CLI is the source of truth for its own workflow. Never hand-write `facet.json`,
`facets.json`, or `facets.lock` from memory. Get current guidance straight from the tool:

```sh
facet instructions
```

That prints an overview and a topic index. Then read the topic that matches the task
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

## CLI not installed

Ask the user whether they want to install the CLI. If they agree, run:

```sh
curl -fsSL https://agentfacets.io/install | bash
```

Alternates: `npm install -g agent-facets` or `bun add -g agent-facets`.

Then re-run `facet --version` to confirm, and continue from Step 2.

## Keep the CLI current

If the installed version is below 0.24.0, run:

```sh
facet self-update
```

Use `--version <x.y.z>` to pick a specific release, or `--dry-run` to preview.

## Headless environments

In CI or sandboxes without a TTY:

- `facet add` requires an installed adapter (e.g., `claude-code`). Pre-install:
  ```sh
  facet adapter add claude-code
  ```
- `facet install` with `--frozen-lockfile` never prompts.
- `facet login` is interactive-only. Use `FACET_TOKEN=fct_pub_…` instead in CI.
