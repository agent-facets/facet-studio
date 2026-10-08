# Facet Studio local catalogue

**Presenting or handing this off?** Follow [DEMO.md](DEMO.md) for setup, host connection, the five-minute walkthrough, and recovery steps.

A Bun prototype that discovers and installs facets, then opens their packaged apps through one connected MCP server. Studio has its own installable facet containing its UI, server and complete local catalogue. The catalogue currently contains the real Meeting to Action facet and is explicitly local; it does not search the public registry.

The host assistant supplies reasoning. Both Studio and Meeting use CopilotKit registered frontend tools, rendered human approval components, and shared AG-UI state. Search runs through a frontend handler. Installation and saving first await the actual CopilotKit human-in-the-loop renderer; declining produces no install/save call. Approved handlers use the existing MCP transport adapter. No separate model API or model credential is used.

## Private registry packages

The private 0.1.1 releases are [@agentfacets/facet-studio](https://agentfacets.io/facets/@agentfacets/facet-studio) and [@agentfacets/meeting-to-action](https://agentfacets.io/facets/@agentfacets/meeting-to-action). Sign in with an account granted access to the `@agentfacets` organization, then install the selected package in a consuming project. Anonymous requests cannot access these packages:

```sh
facet login
facet add @agentfacets/facet-studio@0.1.1
# Optional direct worksheet package:
facet add @agentfacets/meeting-to-action@0.1.1
```

Studio still ships an explicitly local catalogue containing the meeting package. Its discovery screen installs that bundled source through the real CLI; it does not claim registry search. The unscoped app descriptor IDs and companion directory names remain stable routing identities, separate from scoped registry package names. Both packages carry their own server/UI assets; Studio also carries the complete meeting source fixture.

## Discover, install and open in one host

```sh
cd examples/cross-desktop
bun install --frozen-lockfile
bun run build
bun dist/studio-server.js
```

Configure `dist/studio-server.js` once as a stdio MCP server using absolute Bun and script paths. Ask the assistant to call `studio_search`. Search the local catalogue, install a selected entry, then use Open to request its returned tool. A host may place that request in the composer for the user to send. Studio publishes the installed app's tools/resources with MCP list-change notifications in the existing connection; no per-facet server configuration is generated or required.

`FACET_STUDIO_PROJECT` configures the consuming project at server launch (default `./studio-project`). `FACET_STUDIO_CATALOG` optionally selects trusted local catalogue configuration. Neither path is accepted from the app UI. Catalogue entries declare local source paths and stable IDs; the build ships the sample source beneath `dist/c`.

To install Studio itself, use `facet add` with a local source inside the consuming project, or call the generic installer in the supplied smoke script. Run the installed `skills/facet-studio/assets/studio-server.js` companion. Its neighbouring `studio.html`, `catalog.json` and catalogue files are declared skill companions and travel with it. Bun and a compatible Facet adapter remain prerequisites.

```sh
facet build studio-facet --verify
facet build facet --verify
bun scripts/studio-smoke.ts
```

The Studio smoke gate installs both bundles with the real CLI, launches installed Studio from `/tmp`, verifies the bundled sample starts uninstalled even when Studio is installed in that same consuming project, then verifies search, install, tool/resource list-change notifications, cached stable-tool app opening, host plan updates and UI reads before refreshing the tool list. It also checks concurrent installs of two distinct local entries preserve both lock records and keep their primary UI resources isolated.

The small `app.json` contract is a prototype skill companion, not a new Facet manifest field. It declares schemaVersion, app ID, version, Bun runtime, relative JavaScript entrypoint and open tool. Studio requires matching Facet lock identity and companion hashes before starting an app. Adapter-transformed SKILL.md is checked against the source hash in the CLI lock; executable/UI companions must match installed bytes. App IDs are unique in a catalogue, tools/resources are namespaced, and child/tool startup and CLI work are bounded and cancelled on disconnect.

Studio predeclares one generic `studio_app_<hash>` tool per configured catalogue entry. Calling it with `{}` opens that installed app; `{"tool":"original child name","arguments":{...}}` invokes an allowlisted child operation. Original schemas appear in the open result for the assistant and are validated by the child. The wrapper itself has a generic host input schema; dynamic tools still retain their original schemas. The installed UI uses routing metadata to send UI calls through the predeclared tool. Before requesting a plan, it supplies exact routing and the original schema through acknowledged model context when the host supports it, with a three-second timeout. The visible message contains only the meeting request, title and notes. If context updates are unsupported or rejected, the natural request relies on routing already supplied by the open result. Verified installed worksheets start at the meeting step; returned host proposals still open Review. Browser and direct standalone routing remain supported.

Each bridge has a distinct stable primary-resource URI bound to the descriptor's open tool. Resource reads and calls fail before verified installation; source assets are never served as installed apps. This prototype supports one primary UI per app and a fixed catalogue at connection startup. Native Claude rendered discovery and completed installation but did not refresh its tool list after receiving list-change notifications. The stable bridge avoids that dependency. Native results and their version limits are recorded below.

For a fresh-project walkthrough:

1. Configure the Studio server once with a fresh writable `FACET_STUDIO_PROJECT`, then ask for the local catalogue.
2. Install Meeting to Action in the inline Studio card. Choose Open and send its request if the host places it in the composer. Keep the same host connection running.
3. The installed worksheet opens at Capture notes. Enter a title and notes, choose Ask assistant, and send the plain-language request if prompted.
4. Review the assistant's returned worksheet, correct owners or dates, and choose Save. Reopening through Studio reads the saved server-session state.
5. Choose Export Markdown to keep a file before ending the server session.

Save updates the live child server's shared worksheet; it does not write a durable plan file. A server restart loses that session state. Export Markdown creates the portable file through the host/browser download flow. CLI installation persists the app package separately from the plan.

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

## Optional direct worksheet connection

The Studio workflow above is the discovery-to-install entry point. To exercise the worksheet independently, configure a separate stdio MCP server with the absolute Bun executable and the absolute path to `dist/server.js`, then ask the assistant to call `meeting_open`.

After installing the facet, use its installed `skills/meeting-to-action/assets/server.js` companion instead. The example installer writes `claude-desktop.example.json` and `codex.example.toml` in the consuming project with resolved paths. Review and merge the applicable snippet into the host configuration, then reconnect. The installer does not modify global desktop settings.

The host must support MCP Apps to render the worksheet. “Ask assistant for a plan” sends a user message through the MCP Apps bridge. The host assistant calls `meeting_plan`; its validated result becomes an AG-UI `STATE_SNAPSHOT` and updates the CopilotKit `useAgent` state. Hosts may render that result in a new worksheet card; populated host proposals open in Review. Saving edits opens a CopilotKit approval card showing the action snapshot. Approve executes the registered save handler through the same MCP tool; Decline keeps the local edits without saving. Plan data is held in the server session, not persisted to disk; export before ending it. Multiple views attached to one server share this plan.

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

Before publishing, build and verify the actual archives as well as the loose source. The offline gate accepts the existing Facet protocol module from a development checkout:

```sh
facet build facet --emit-manifest
facet build studio-facet --emit-manifest
bun scripts/archive-smoke.ts /path/to/facets/packages/protocol/src/index.ts
```

This checks the built archive's paths, membership and hashes with the exported protocol verifier, and prints expanded byte counts. It does not claim compliance with registry size limits. Studio uses short hashed catalogue directories, and the build rejects companion paths longer than 100 bytes to avoid truncation in the current archive writer.

The server bundle embeds all runtime dependencies and companion instructions. The installed server requires Bun but neither `node_modules` nor the source checkout. To verify an installed companion:

```sh
bun scripts/smoke.ts /absolute/path/to/installed/skills/meeting-to-action/assets/server.js
```

The smoke client launches the server with `/tmp` as its working directory, lists four tools, reads the inline app resource, accepts a host plan, and rejects an invalid plan.

The 0.1.1 CopilotKit approval flow has automated runtime coverage with actual mounted hooks, core handlers and rendered buttons, plus the native Claude walkthrough below.

## Verified surfaces

- Browser: sample loading, owner editing, save, and honest host-unavailable state exercised through the browser UI.
- MCP protocol: stdio tools, UI resource, valid host plan and invalid plan exercised with the SDK client.
- Packaging: fresh local CLI install and repeated install succeeded; installed server passed the same smoke check outside the source checkout.

| Native surface | Verified evidence | Remaining limit |
|---|---|---|
| Claude Desktop, 0.1.1 | Native search click, decline installation with no install, approve real CLI installation, and Open into Capture notes. The host returned a plan; editing Maya to Rae followed by declining Save preserved the edits, and approving Save succeeded. No post-install host restart was needed. | Verified with the bundled local catalogue in this setup, not every host version or catalogue. |
| Codex, earlier 0.1.0 connection | User-provided inline rendering image; user edited Maya to Rae and reported Save succeeded. Independent stable-Open readback returned Rae with host provenance and edited state. | The newly configured 0.1.1 connection has not had its full visual/interaction walkthrough verified. Do not present the earlier result as 0.1.1 approval-flow evidence. |

The local AG-UI adapter forwards validated host state and emits lifecycle events. It does not generate sample content on behalf of an assistant. CopilotKit's headless/context exports keep the self-contained resource within the MCP SDK's default message limit. The current core registration API is named `agents__unsafe_dev_only`; this is a prototype integration, with exact dependency versions recorded in the lockfile.

The fresh-install check creates a new temporary project, retains the caller's existing Facet adapter configuration, installs through the real CLI, compares bundled/installed hashes, repeats the installation, and launches the installed server from `/tmp`. Do not point `FACET_DIR` at an empty directory for this check: that hides the available adapters. If using an isolated Facet home, install a compatible adapter into that home first. The fixture path is printed and retained for inspection.
