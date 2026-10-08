# Meeting to Action

A Bun prototype that installs a facet containing a skill, an MCP Apps worksheet, and its server. The host assistant reasons about meeting notes. CopilotKit React consumes the resulting AG-UI state. No separate model API or model credential is used.

## Run the browser preview

```sh
cd examples/cross-desktop
bun install --frozen-lockfile
bun run build
PORT=4328 bun start
```

Open http://127.0.0.1:4328. The server binds only to loopback. The preview uses the same worksheet as the MCP resource. It labels host reasoning as unavailable; use the sample, edit the worksheet, save, and export Markdown.

The setup step discovers the Facet CLI and exposes explicit install and sign-in controls. Sign-in delegates to `facet login --no-browser`. The user completes device authorization at the displayed URL. The service stores no credentials. A local facet install can work without registry authentication.

“Install this facet” calls the real CLI against a fixed local source, writes the consuming project under `meeting-to-action-project/`, and verifies that server/UI companions were materialized. At least one compatible Facet adapter must already be installed; inspect with `facet adapter list` and install the adapter for your host if needed. `FACET_EXAMPLE_PROJECT` sets the consuming directory at server launch, never through browser input.

## Open inside an assistant

After building, configure a stdio MCP server with the absolute Bun executable and the absolute path to `dist/server.js`. Ask the assistant to call `meeting_open`.

After installing the facet, use its installed `skills/meeting-to-action/assets/server.js` companion instead. The example installer writes `claude-desktop.example.json` and `codex.example.toml` in the consuming project with resolved paths. Review and merge the applicable snippet into the host configuration, then reconnect. The installer does not modify global desktop settings.

The host must support MCP Apps to render the worksheet. “Ask assistant for a plan” sends a user message through the MCP Apps bridge. The host assistant calls `meeting_plan`; its validated result becomes an AG-UI `STATE_SNAPSHOT` and updates the CopilotKit `useAgent` state. Saving edits calls the same tool. Plan data is held in the server session, not persisted to disk; export before ending it. Multiple views attached to one server share this plan.

## Package and verify

```sh
bun test
bun run typecheck
bun run build
bun scripts/smoke.ts
bun scripts/install-smoke.ts
facet build facet --verify
facet build facet
```

The build generates `facet/skills/meeting-to-action/assets/server.js` and `view.html`. `facet.json` declares them as skill companions. `facet add ./facet` installs those files; a raw `.facet` archive is not the local-source argument.

The server bundle embeds all runtime dependencies and companion instructions. The installed server requires Bun but neither `node_modules` nor the source checkout. To verify an installed companion:

```sh
bun scripts/smoke.ts /absolute/path/to/installed/skills/meeting-to-action/assets/server.js
```

The smoke client launches the server with `/tmp` as its working directory, lists four tools, reads the inline app resource, accepts a host plan, and rejects an invalid plan.

## Verified surfaces

- Browser: sample loading, owner editing, save, and honest host-unavailable state exercised through the browser UI.
- MCP protocol: stdio tools, UI resource, valid host plan and invalid plan exercised with the SDK client.
- Packaging: fresh local CLI install and repeated install succeeded; installed server passed the same smoke check outside the source checkout.
- Native Claude Desktop and Codex rendering: not yet verified. Protocol and package checks do not establish host rendering support.

The local AG-UI adapter forwards validated host state and emits lifecycle events. It does not generate sample content on behalf of an assistant. CopilotKit's headless/context exports keep the self-contained resource within the MCP SDK's default message limit. The current core registration API is named `agents__unsafe_dev_only`; this is a prototype integration, with exact dependency versions recorded in the lockfile.

The fresh-install check creates a new temporary project, retains the caller's existing Facet adapter configuration, installs through the real CLI, compares bundled/installed hashes, repeats the installation, and launches the installed server from `/tmp`. Do not point `FACET_DIR` at an empty directory for this check: that hides the available adapters. If using an isolated Facet home, install a compatible adapter into that home first. The fixture path is printed and retained for inspection.
