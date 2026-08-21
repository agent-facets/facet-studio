// What the server and the host actually agreed on.
//
// Two facts decide how facet-studio behaves, and neither is visible from inside
// a session. Whether the host asked for UI decides if there is a console at
// all; where the project root came from decides whether a read means anything.
// An agent that cannot see either has to guess, and both wrong guesses look
// exactly like the right answer — a tool list with no panel, and a project that
// appears to have no facets.
//
// Startup writes the same facts to stderr, which is the right place for them
// when a host captures it. Not every host does, and a bridged host may forward
// only tools, so this is the channel that survives: a tool the agent can call
// and read for itself.

import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootReader, type RootAware, type ProjectRoot } from "./root.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RegistrationDeps } from "./server.js";

/**
 * How much interface this host can render, which is what a skill branches on.
 *
 * Deliberately not a host name. A matrix of product names rots the moment a
 * product ships a release; what the handshake said does not.
 */
export type SurfaceTier = "apps" | "text";

export interface CapabilitiesData {
    kind: "capabilities";
    /** "apps" when the host negotiated MCP Apps, "text" otherwise. */
    tier: SurfaceTier;
    /** True when a console can be opened; false when prose is the only surface. */
    consoleAvailable: boolean;
    /** Whether the host offered its open folders. */
    rootsAdvertised: boolean;
    /**
     * Always true. The registry is a remote catalog, so finding a facet has
     * nothing to do with the current directory — and a caller that reads
     * `projectFound: false` as "nothing works here" would be wrong. Stated as
     * a field rather than left implied, so nothing has to infer it.
     */
    registryAvailable: true;
    projectRoot: string;
    /** Exactly what supplied the root: an env var's name, `roots/list`, or `cwd`. */
    rootVia: string;
    /** False when nothing named a project and the working directory was assumed. */
    rootConfirmed: boolean;
    /** Whether the resolved root actually holds a facets.json. */
    projectFound: boolean;
    /** Open folders the host offered that were not chosen. */
    otherRoots: string[];
}

export function readCapabilities(deps: RegistrationDeps & RootAware, root: ProjectRoot): CapabilitiesData {
    return {
        kind: "capabilities",
        tier: deps.supportsUi === true ? "apps" : "text",
        consoleAvailable: deps.supportsUi === true,
        rootsAdvertised: deps.clientCapabilities?.roots !== undefined,
        registryAvailable: true,
        projectRoot: root.path,
        rootVia: root.via,
        rootConfirmed: root.confirmed,
        projectFound: existsSync(path.join(root.path, "facets.json")),
        otherRoots: root.otherRoots,
    };
}

/**
 * The prose version, written for the agent that has to decide what to do next
 * rather than for a person reading a status page.
 */
export function toText(data: CapabilitiesData): string {
    const lines = [
        data.consoleAvailable
            ? "Console: available. This host renders MCP Apps, so facet tools open the panel and the user can act in it."
            : "Console: not available. This host did not negotiate MCP Apps, so prose is the only surface.",
        // Said before anything about the project, and unconditionally. Looking
        // for facets is not a question about the current directory, and an
        // agent that reads a missing project as "degraded" will fall back to
        // prose for a request the Registry screen answers perfectly well.
        "Registry: available. Browsing, searching, and reading facets need no project — facet_browse and facet_detail work anywhere, and open the Registry screen.",
    ];

    if (data.projectFound) {
        lines.push(`Project: ${data.projectRoot} (via ${data.rootVia}).`);
    } else {
        lines.push(
            `Project: none found at ${data.projectRoot} (via ${data.rootVia}).`,
            "That limits only the project-scoped tools — facet_list, facet_project, facet_add, facet_remove, facet_update. Everything else is unaffected.",
        );
        if (!data.rootConfirmed) {
            lines.push("Nothing named a project, so that path is just the server's working directory. Pass `directory` or set FACET_PROJECT_ROOT to work against a real one.");
        }
    }

    if (data.otherRoots.length > 0) {
        lines.push(`Other folders the host has open: ${data.otherRoots.join(", ")}`);
    }
    return lines.join("\n");
}

const capabilitiesShape = {};
const capabilitiesSchema = z.object(capabilitiesShape);

export function registerCapabilities(server: McpServer, deps: RegistrationDeps & RootAware = {} as RegistrationDeps): void {
    const readRoot = rootReader(deps);

    const config = {
        title: "Host capabilities",
        description:
            "Report what this host negotiated and where the project root came from: whether an interactive console can be opened, and whether a project was actually found. Call this before answering a facet request when the surface matters.",
        inputSchema: capabilitiesShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        capabilitiesSchema.parse(rawArgs ?? {});
        const data = readCapabilities(deps, readRoot());
        return {
            content: [{ type: "text", text: toText(data) }],
            structuredContent: data as unknown as Record<string, unknown>,
        };
    };

    // No panel pointer on this one. It reports whether a console exists; opening
    // one to say so would answer the question by assuming it.
    server.registerTool("facet_capabilities", config, handler as never);
}
