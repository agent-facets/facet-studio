# Using Facets

Facets are portable bundles of skills, agents, and commands for AI coding tools.
Whenever you are about to create, edit, build, publish, add, update, or remove a
facet—or answer a question about how facets work—do NOT improvise. Route the work
through the facet-studio MCP tools if they are connected, and through the `facet`
CLI otherwise. Both ship their own agent-facing instructions.

## Read this first: is the MCP server connected?

If you can see `facet_*` tools, use them and skip to "MCP Server Routing" below.
Everything from "Check the CLI" onward is the fallback for when they are absent —
do not run a `facet` shell command, and do not offer one to the user, for anything
a `facet_*` tool covers.

## MCP Server Routing

Prefer the `facet_*` tools over raw CLI calls — same operations, structured
results, branded panels where the host renders them.

**Where the host draws the panel, the panel is the answer, and you add nothing to
it.** Every tool result says so in its own text; that instruction outranks any
formatting habit and any contract in the `presentation` skill, which covers
text-only hosts and operation outcomes. Concretely, after a read renders a panel:
no prose summary, no list or table of the results, no "here are the ones that
fit", no offer to install, and above all no `facet ...` command block — the panel
has an Install button, so printing a CLI line for the same thing is telling the
user to do by hand what is already one click away. Say something only if the user
asked for something the panel cannot show, and then in one short sentence.

### Discovery routing

Questions about what facets exist, what they do, or which to install route to one `facet_browse` call—never a browse-then-detail chain, and never the CLI's `facet search` when the MCP server is connected. The browse result already answers the question. Pass the subject of the question as `query`—one or two keywords, space separated. "What facets help with my git workflows" is a search for `git worktree`, not a request for the whole catalog. Each keyword is searched on its own and the results merged, so a second one only ever adds matches; pick the subject words a facet's name or description would plausibly use and leave out filler like "facets" or "help". Keywords that match nothing fall back to everything published, so a broad question still gets an answer. Tools like `facet_contents`, `facet_readme`, and `facet_update` accept an optional `version` argument that defaults to the latest release.

## Check the CLI and run instructions

Everything below is the no-MCP fallback path.

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

## Headless environments

In CI or sandboxes without a TTY:

- `facet add` requires an installed adapter (e.g., `claude-code`). Pre-install:
  ```sh
  facet adapter add claude-code
  ```
- `facet install` with `--frozen-lockfile` never prompts.
- `facet login` is interactive-only. Use `FACET_TOKEN=fct_pub_…` environment variable instead.
