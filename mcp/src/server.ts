// The facet-studio MCP server.
//
// This file owns three things and nothing else: the server's identity, the
// capability handshake with the host, and the single seam (`registerAll`) where
// tools, panels, and auth get wired in. The tools themselves live in ./tools,
// ./auth, and ./view/panel — this file only calls their registrars.

import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { registerAuth } from "./auth.js";
import { registerTools } from "./tools.js";
import { primeResourceListing, registerPanel } from "./view/panel.js";

/** How this server introduces itself in the MCP handshake. */
export const SERVER_NAME = "facet-studio";
export const SERVER_VERSION = "0.2.0";

/**
 * Whatever the host advertised under the MCP Apps UI extension, or `undefined`
 * when the host can't render UI at all. Borrowed from `getUiCapability` so the
 * shape stays in lockstep with the ext-apps package.
 */
export type UiCapability = ReturnType<typeof getUiCapability>;

/** Collaborators handed to the server at construction time. */
export interface StudioServerDeps {
    /**
     * Swap out the registration seam. Real builds leave this alone and get
     * {@link registerAll}; tests use it to watch what the seam is handed.
     */
    registerAll?: RegisterAll;
}

/**
 * What the seam receives: the original deps plus everything we learned about
 * the host during the handshake. `supportsUi` is the one flag callers should
 * branch on when deciding between an App tool and a text-only fallback.
 */
export interface RegistrationDeps extends StudioServerDeps {
    clientCapabilities: ClientCapabilities | undefined;
    uiCapability: UiCapability;
    supportsUi: boolean;
}

export type RegisterAll = (server: McpServer, deps: RegistrationDeps) => void;

/**
 * The one place tools, panels, and auth register themselves.
 *
 * It runs once per connection, right after the handshake, which is why `deps`
 * carries the host's capabilities: registration can differ between a host that
 * renders UI and one that doesn't.
 *
 * The order matters, and not for the reason you'd guess. This runs inside the
 * `oninitialized` callback, where nobody catches a throw — so if one registrar
 * blew up, every registrar after it would silently never run and the host would
 * see a half-empty server. The panel is the only one that touches resources
 * (the riskier registration, since resource capabilities have to be primed
 * before connect), so it goes last: the tools are already published by then.
 * The order also fixes what `tools/list` returns — the nine lifecycle tools in
 * spec-table order, then the two sign-in tools.
 */
export function registerAll(server: McpServer, deps: RegistrationDeps): void {
    registerTools(server, deps);
    registerAuth(server, deps);
    registerPanel(server, deps);
}

/**
 * Builds a configured server. It is not connected to anything yet — hand the
 * result a transport (stdio in production, an in-memory pair in tests).
 */
export function createServer(deps: StudioServerDeps = {}): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

    // Both listings have to be primed before `connect()`, because everything we
    // actually register happens after the handshake. See the note on
    // primeToolListing below, and its twin in view/panel.ts.
    primeToolListing(server);
    primeResourceListing(server);

    const register = deps.registerAll ?? registerAll;

    // The host's capabilities only exist once it has answered the handshake, so
    // registration has to wait for this callback rather than run at build time.
    server.server.oninitialized = () => {
        const clientCapabilities = server.server.getClientCapabilities();
        const uiCapability = getUiCapability(clientCapabilities);
        register(server, {
            ...deps,
            clientCapabilities,
            uiCapability,
            supportsUi: uiCapability !== undefined,
        });
    };

    return server;
}

/**
 * Makes the server answer `tools/list` with an empty list before any tool
 * exists.
 *
 * The SDK only installs the tools/list handler — and only advertises the
 * `tools` capability — the first time something is registered. But our
 * registrations happen after the handshake, by which point the capability list
 * the host received is already final. Registering a throwaway tool and dropping
 * it immediately gets us both: the handler and the capability stick around, the
 * tool list starts out empty, and anything registered later reaches the host
 * through the usual list-changed notification.
 */
function primeToolListing(server: McpServer): void {
    server
        .registerTool("facet_studio_probe", { description: "Placeholder; removed immediately." }, () => ({
            content: [],
        }))
        .remove();
}

/** Runs the server over stdio, the transport hosts launch it with. */
export async function main(): Promise<void> {
    const server = createServer();
    await server.connect(new StdioServerTransport());
}

/**
 * True when this file is the process entry point. Bun and recent Node set
 * `import.meta.main`; older Node needs the argv comparison.
 */
function isRunDirectly(): boolean {
    const meta = import.meta as ImportMeta & { main?: boolean };
    if (typeof meta.main === "boolean") {
        return meta.main;
    }
    const entry = process.argv[1];
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isRunDirectly()) {
    main().catch((error: unknown) => {
        // stdout is the protocol channel, so diagnostics go to stderr.
        console.error("facet-studio MCP server failed to start:", error);
        process.exit(1);
    });
}
