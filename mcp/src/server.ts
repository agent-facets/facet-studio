// The facet-studio MCP server.
//
// This file owns four things and nothing else: the server's identity, the
// capability handshake with the host, the single seam (`registerAll`) where
// tools, panels, and auth get wired in, and what happens when that seam fails —
// the server stops answering rather than serve a surface it never finished
// building. The tools themselves live in ./tools, ./auth, and ./view/panel;
// this file only calls their registrars.

import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListResourceTemplatesRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
    RootsListChangedNotificationSchema,
    type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { ProjectRootHolder, describeNegotiation, resolveRootSync, type ProjectRoot, type RootDeps } from "./root.js";
import { registerAuth } from "./auth.js";
import { registerTools } from "./tools.js";
import { registerBrowse } from "./browse.js";
import { registerProject } from "./project.js";
import { registerAuthoring } from "./authoring.js";
import { registerCapabilities } from "./capabilities.js";
import { primeResourceListing, registerPanel } from "./view/panel.js";

// A Bun macro: this call runs while *this file* is being transpiled or bundled,
// and its result is baked in below as a plain string literal. Nothing is
// compiled, read, or fetched once the server is running.
//
// It reaches into the repo's build tooling because a macro cannot be imported
// from a module that pulls in the MCP Apps SDK — see compileBrowserScript for
// the details. The import itself disappears at build time, so the shipped
// server bundle has no tie to this path.
// @ts-ignore -- the build script has no .js twin; Bun resolves it, tsc can't.
import { compileBrowserScript } from "../../scripts/build-plugin.js" with { type: "macro" };

/** How this server introduces itself in the MCP handshake. */
export const SERVER_NAME = "facet-studio";
export const SERVER_VERSION = "0.6.0";

/**
 * The first line of the compiled view script. Minification renames everything
 * else, so this is the stable thing to look for when checking that a served
 * panel really did get its script. Bun macros only accept literal arguments,
 * which is why the same text is spelled out again in the call below; the panel
 * integration test reads the served page and fails if the two ever drift.
 */
export const VIEW_SCRIPT_BANNER = "// facet-studio panel view";

/**
 * The panel's browser half, compiled and inlined at build time. The `await` is
 * a formality — by the time this runs, the macro has already replaced the call
 * with the finished string, so nothing is pending.
 */
const VIEW_SCRIPT: string = await compileBrowserScript(
    "mcp/src/view/panel.ts",
    "// facet-studio panel view",
);

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
    /**
     * Told about a registrar that threw, so a host or a test can see it.
     * Defaults to a line on stderr. This is only where the news goes — it has
     * no say in what happens next, and the server stops serving either way.
     * If it throws, the throw is caught and logged: it can neither hold up the
     * refusal nor stand in for the registration error the caller is given.
     */
    onRegistrationError?: (failure: RegistrationFailure) => void;
}

/** A registrar that threw, and which one it was. */
export interface RegistrationFailure {
    /** "tools", "auth", "panel", or "registration" for the seam as a whole. */
    registrar: string;
    error: unknown;
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
    /**
     * Where the project is, read fresh on every tool call. Registration cannot
     * wait for the client to answer `roots/list`, so this opens on the best
     * synchronous answer and upgrades itself once the client replies.
     */
    rootHolder?: ProjectRootHolder;
}

export type RegisterAll = (server: McpServer, deps: RegistrationDeps) => void;

/**
 * The opening words of every refusal, and the thing to look for when checking
 * that a server really did stop serving rather than come up empty.
 */
export const NOT_SERVING = "facet-studio is not serving";

/**
 * Runs one registrar and hands its failure back instead of letting it fly.
 *
 * Holding the throw here is what lets the registrars behind it still get their
 * turn, so one call can collect every casualty rather than only the first. It
 * is not the same as forgiving the failure — every caller below either reports
 * what comes back or acts on it.
 */
function contain(registrar: string, run: () => void): RegistrationFailure | undefined {
    try {
        run();
        return undefined;
    } catch (error) {
        return { registrar, error };
    }
}

/** How a failure reads in a sentence: "the tools registrar", "the registration seam". */
function nameOf(registrar: string): string {
    return registrar === "registration" ? "the registration seam" : `the ${registrar} registrar`;
}

/** The shortest true sentence about why something threw. */
function reasonFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** "the panel registrar failed: Cannot register capabilities after connecting" */
function describe(failure: RegistrationFailure): string {
    return `${nameOf(failure.registrar)} failed: ${reasonFor(failure.error)}`;
}

/** Where a registration failure goes when the caller supplied no handler. */
function reportRegistrationFailure(failure: RegistrationFailure): void {
    // stdout is the protocol channel, so diagnostics go to stderr.
    console.error(`facet-studio: ${describe(failure)}`, failure.error);
}

/**
 * Tells whoever is listening about a failure, without letting them change the
 * outcome.
 *
 * Reporting is a courtesy; refusing to serve is the policy. A reporter can throw
 * for reasons that have nothing to do with the server — telemetry is down, a log
 * sink is full — and if that throw escaped it would do real damage twice over:
 * it could stop the refusal from being installed, and it would take the place of
 * the registration error the caller is waiting to hear about. So it dies here,
 * with a line on stderr, and the original failure carries on to the caller.
 *
 * Every call to a reporter goes through this. There is no safe unguarded one.
 */
function notify(report: (failure: RegistrationFailure) => void, failure: RegistrationFailure): void {
    try {
        report(failure);
    } catch (reporterError) {
        // stdout is the protocol channel, so diagnostics go to stderr.
        console.error(`facet-studio: the registration-failure reporter threw; ${describe(failure)}`, reporterError);
    }
}

/**
 * The requests this server would answer if registration had gone well.
 *
 * It is the exact list of methods covered by the two capabilities primed in
 * {@link createServer} — tools and resources — because those are the only ones
 * the SDK will even let us install a handler for. Prime a third capability
 * there and its methods belong here too.
 */
const SERVED_REQUESTS = [
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
] as const;

/**
 * Stops the server answering, and makes every answer say why.
 *
 * The handshake is already over by the time registration runs, so the
 * connection cannot be refused — but what the server does with it afterwards is
 * still ours. An empty tool list is a lie a host cannot see through: it looks
 * exactly like a server that legitimately has nothing to offer. An error naming
 * the registrar that failed and the reason it failed is something the host, or
 * the person reading its logs, can act on.
 *
 * Every existing handler is replaced, and anything else that arrives gets the
 * same treatment through the fallback, so no route back into a half-built
 * surface is left open.
 */
function refuseToServe(server: McpServer, failure: RegistrationFailure): void {
    const message = `${NOT_SERVING}: ${describe(failure)}`;
    const refuse = (): never => {
        throw new McpError(ErrorCode.InternalError, message);
    };

    for (const schema of SERVED_REQUESTS) {
        server.server.setRequestHandler(schema, refuse);
    }
    server.server.fallbackRequestHandler = refuse;

    // stdout is the protocol channel, so diagnostics go to stderr.
    console.error(message);
}

/**
 * The one place tools, panels, and auth register themselves.
 *
 * It runs once per connection, right after the handshake, which is why `deps`
 * carries the host's capabilities: registration can differ between a host that
 * renders UI and one that doesn't.
 *
 * Each registrar runs inside {@link contain}, so one of them blowing up doesn't
 * rob the ones behind it of their turn — every casualty gets named, not just
 * the first. Each is reported as it happens, and then the whole set is thrown
 * as one error for the caller to act on. Nothing is swallowed: a server that
 * came up missing half its surface and said nothing is the bug this prevents.
 *
 * The order still matters. The panel is the only one that touches resources
 * (the riskier registration, since resource capabilities have to be primed
 * before connect), so it goes last: the tools are already published by then.
 * The order also fixes what `tools/list` returns — the nine lifecycle tools in
 * spec-table order, then the registry reads, then the two project reads, then
 * the two sign-in tools.
 *
 * The panel gets the compiled view script handed to it. Without it the page
 * the host loads is inert markup: no bootstrap, no `ontoolresult`, no card.
 */
export function registerAll(server: McpServer, deps: RegistrationDeps): void {
    const failures = [
        contain("tools", () => {
            registerTools(server, deps);
        }),
        contain("browse", () => {
            registerBrowse(server, deps);
        }),
        contain("project", () => {
            registerProject(server, deps);
        }),
        contain("authoring", () => {
            registerAuthoring(server, deps);
        }),
        contain("capabilities", () => {
            registerCapabilities(server, deps);
        }),
        contain("auth", () => {
            registerAuth(server, deps);
        }),
        contain("panel", () => {
            registerPanel(server, deps, { viewScript: VIEW_SCRIPT });
        }),
    ];

    const report = deps.onRegistrationError ?? reportRegistrationFailure;
    const failed = failures.filter((failure): failure is RegistrationFailure => failure !== undefined);
    for (const failure of failed) {
        // Guarded, because a reporter that threw here would end the loop and fly
        // out of the seam in place of the throw below — the caller would hear
        // about the reporter and never about the registrars that actually failed.
        notify(report, failure);
    }

    if (failed.length > 0) {
        throw new AggregateError(
            failed.map(failure => failure.error),
            failed.map(describe).join("; "),
        );
    }
}

/**
 * Sets up the project root and keeps it current.
 *
 * The root starts as whatever can be worked out without talking to anyone —
 * configuration, then the environment, then the working directory — because
 * registration is synchronous and tools have to exist before the first call.
 * Asking the client which folders it has open is a request, so it happens
 * immediately afterwards and replaces that opening answer when it lands.
 *
 * Both the request and the subscription are conditional on the client actually
 * advertising `roots`. Asking a client that never offered the capability earns
 * a protocol error rather than an answer.
 */
function startRootHolder(
    server: McpServer,
    clientCapabilities: ClientCapabilities | undefined,
    deps: StudioServerDeps,
): ProjectRootHolder {
    const supportsRoots = clientCapabilities?.roots !== undefined;

    const rootDeps: RootDeps = {
        ...(supportsRoots ? { listRoots: () => server.server.listRoots() } : {}),
        // Which candidate root is the real project: the one with a facets.json
        // in it. Only consulted when a client offers more than one folder.
        hasProject: dir => existsSync(path.join(dir, "facets.json")),
    };

    const holder = new ProjectRootHolder(resolveRootSync(rootDeps), rootDeps);

    // stdout is the protocol channel, so this goes to stderr, which hosts
    // capture. Logged again after the roots round trip, because that is the one
    // source that can change the answer after startup.
    const report = (root: ProjectRoot): void => {
        console.error(
            describeNegotiation({
                ui: getUiCapability(clientCapabilities) !== undefined,
                roots: supportsRoots,
                root,
                looksLikeProject: existsSync(path.join(root.path, "facets.json")),
            }),
        );
    };
    const atStartup = holder.current();
    report(atStartup);

    if (supportsRoots) {
        // Nothing waits on this. A client that is slow to answer just means the
        // first call or two run against the synchronous answer, which is the
        // same one they would have had anyway. Only a different answer is worth
        // a second line — repeating the first one would just be noise.
        void holder
            .refresh()
            .then(root => {
                if (root.path !== atStartup.path || root.via !== atStartup.via) {
                    report(root);
                }
            })
            .catch(() => undefined);

        server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
            await holder
                .refresh()
                .then(report)
                .catch(() => undefined);
        });
    }

    return holder;
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
    //
    // Nothing catches a throw from here — the SDK just loses it — so the seam is
    // contained too, not only the registrars inside it. An injected seam, or the
    // capability lookup itself, can fail just as easily as a registrar can.
    //
    // And this is where the policy lives: if anything at all went wrong, the
    // server stops answering. A half-registered server is worse than no server,
    // because the host sees a connection that works and a surface that is
    // missing pieces, with no way to tell the difference from a server that
    // simply has less to offer. Note what does NOT count as going wrong — a
    // registrar that bows out because the host can't use what it offers, like
    // the panel facing a text-only host, returns normally and is not a failure.
    server.server.oninitialized = () => {
        const failure = contain("registration", () => {
            const clientCapabilities = server.server.getClientCapabilities();
            const uiCapability = getUiCapability(clientCapabilities);
            const rootHolder = startRootHolder(server, clientCapabilities, deps);
            register(server, {
                ...deps,
                clientCapabilities,
                uiCapability,
                supportsUi: uiCapability !== undefined,
                rootHolder,
            });
        });
        if (failure !== undefined) {
            // Refusal goes in first. Telling someone is the next thing that
            // happens, not the thing the refusal waits on: a reporter that
            // throws on the way out used to leave the half-built surface open
            // for business, which is the exact outcome this whole policy exists
            // to prevent. Install the refusal, then send the news.
            refuseToServe(server, failure);
            notify(deps.onRegistrationError ?? reportRegistrationFailure, failure);
        }
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
