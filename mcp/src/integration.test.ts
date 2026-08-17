// What a host actually sees when it connects to facet-studio.
//
// Every other test file in this package checks one module in isolation, which
// leaves the most expensive bug in the project uncovered: a server that builds
// fine, passes every unit test, and then serves an empty tool list because the
// registration seam was never wired up. Nothing here looks at the registrar
// functions. A real MCP client connects over the SDK's in-memory transport
// pair, completes a real handshake against the REAL exported seam, and asks
// `tools/list` and `resources/list` what is there.
//
// Both host shapes are exercised, because they take different paths through the
// registrars: one that negotiated the MCP Apps UI extension, and one that never
// heard of it. The text-only host is the one that must not break — it gets no
// panel, but it must still get every tool.

import { describe, expect, test } from "bun:test";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";
import { TOOL_SPECS } from "./tools.js";
import { PANEL_RESOURCE_URI } from "./view/panel.js";

/** A host that negotiated the MCP Apps UI extension. */
const UI_CAPABLE: ClientCapabilities = { extensions: { [EXTENSION_ID]: {} } };

/** A plain host with no UI extension. The fallback path. */
const TEXT_ONLY: ClientCapabilities = {};

/**
 * The full published surface, written out by hand on purpose.
 *
 * Deriving this from the source would make the test agree with whatever the
 * code happens to do. Spelling it out means a tool that silently disappears —
 * or quietly appears — fails the build. `matchesTheSpecTable` below keeps the
 * hand-written list honest against the real spec table.
 */
const EXPECTED_TOOLS = [
    "facet_list",
    "facet_verify",
    "facet_build",
    "facet_create",
    "facet_modify",
    "facet_add",
    "facet_update",
    "facet_install",
    "facet_remove",
    "facet_login",
    "facet_whoami",
] as const;

/** The two tools that come from ./auth rather than the lifecycle spec table. */
const AUTH_TOOLS = ["facet_login", "facet_whoami"] as const;

interface Connection {
    client: Client;
    close: () => Promise<void>;
}

/**
 * Connects a real client to a real server built the way production builds it —
 * `createServer()` with no injected seam, so the exported `registerAll` runs.
 */
async function connect(capabilities: ClientCapabilities): Promise<Connection> {
    const server = createServer();
    const client = new Client({ name: "integration-host", version: "0.0.0" }, { capabilities });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

/** Runs `body` against a connected client and always closes both ends. */
async function withHost(capabilities: ClientCapabilities, body: (client: Client) => Promise<void>): Promise<void> {
    const connection = await connect(capabilities);
    try {
        await body(connection.client);
    } finally {
        await connection.close();
    }
}

describe("the published surface, over a real client", () => {
    test("the hand-written tool list still matches the real spec table", () => {
        // If a lifecycle tool is added or renamed in tools.ts, this is the test
        // that fails first, and the fix is to update EXPECTED_TOOLS deliberately.
        expect([...TOOL_SPECS.map(spec => spec.name), ...AUTH_TOOLS]).toEqual([...EXPECTED_TOOLS]);
        expect(EXPECTED_TOOLS).toHaveLength(11);
    });

    for (const [label, capabilities] of [
        ["ui-capable", UI_CAPABLE],
        ["text-only", TEXT_ONLY],
    ] as const) {
        test(`a ${label} host is served every tool, in order`, async () => {
            await withHost(capabilities, async client => {
                const listed = await client.listTools();
                expect(listed.tools.map(tool => tool.name)).toEqual([...EXPECTED_TOOLS]);
            });
        });

        test(`a ${label} host gets usable schemas, not stubs`, async () => {
            await withHost(capabilities, async client => {
                const listed = await client.listTools();
                const byName = new Map(listed.tools.map(tool => [tool.name, tool]));

                for (const tool of listed.tools) {
                    expect(tool.description ?? "").not.toBe("");
                    expect(tool.inputSchema.type).toBe("object");
                    expect(tool.annotations).toBeDefined();
                }

                // Each lifecycle tool publishes the arguments its spec declares,
                // which is only true if the real spec table did the registering.
                for (const spec of TOOL_SPECS) {
                    const published = byName.get(spec.name);
                    const properties = Object.keys(published?.inputSchema.properties ?? {});
                    expect(properties).toEqual(expect.arrayContaining(Object.keys(spec.shape)));
                }
            });
        });
    }

    test("both listings are advertised in the handshake, before anything registers", async () => {
        // Registration happens after the handshake, so if these capabilities
        // weren't primed up front no host would ever ask for either list — the
        // exact way this server could ship looking empty.
        await withHost(UI_CAPABLE, async client => {
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            expect(client.getServerCapabilities()?.resources).toBeDefined();
        });
    });
});

describe("the panel resource", () => {
    test("a ui-capable host is offered the panel at the spec URI and MIME type", async () => {
        await withHost(UI_CAPABLE, async client => {
            const listed = await client.listResources();
            expect(listed.resources.map(resource => resource.uri)).toEqual([PANEL_RESOURCE_URI]);
            expect(listed.resources[0]?.mimeType).toBe("text/html;profile=mcp-app");
            expect(listed.resources[0]?.mimeType).toBe(RESOURCE_MIME_TYPE);
        });
    });

    test("reading it returns the branded panel document", async () => {
        await withHost(UI_CAPABLE, async client => {
            const read = await client.readResource({ uri: PANEL_RESOURCE_URI });
            const contents = read.contents[0];
            expect(contents?.uri).toBe(PANEL_RESOURCE_URI);
            expect(contents?.mimeType).toBe("text/html;profile=mcp-app");
            expect(String(contents?.text)).toContain("<!doctype html>");
            expect(String(contents?.text)).toContain('id="facet-panel"');
        });
    });

    test("no tool points a ui-capable host at a view that was never published", async () => {
        await withHost(UI_CAPABLE, async client => {
            const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
            const published = new Set(resources.resources.map(resource => resource.uri));

            const pointers = tools.tools.map(tool => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri);
            // Not a vacuous check: the UI host is supposed to get real pointers.
            expect(pointers.filter(uri => uri !== undefined)).not.toHaveLength(0);
            for (const uri of pointers) {
                if (uri !== undefined) {
                    expect(published.has(uri)).toBe(true);
                }
            }
        });
    });

    test("a text-only host is offered no panel, and does not need one", async () => {
        await withHost(TEXT_ONLY, async client => {
            const listed = await client.listResources();
            expect(listed.resources.map(resource => resource.uri)).not.toContain(PANEL_RESOURCE_URI);

            // The fallback contract: the lifecycle tools drop their UI metadata
            // rather than advertising a panel this host can never render.
            const tools = await client.listTools();
            const byName = new Map(tools.tools.map(tool => [tool.name, tool]));
            for (const spec of TOOL_SPECS) {
                expect(byName.get(spec.name)?._meta?.ui).toBeUndefined();
            }
        });
    });
});
