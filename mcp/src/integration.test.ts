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
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    VIEW_SCRIPT_BANNER,
    createServer,
    registerAll,
    type RegistrationDeps,
    type RegistrationFailure,
} from "./server.js";
import { TOOL_SPECS } from "./tools.js";
import {
    PANEL_CONTAINER_ID,
    PANEL_RESOURCE_URI,
    buildPanelHtml,
    primeResourceListing,
    renderResult,
    type PanelDocument,
    type PanelElement,
    type PanelFragment,
} from "./view/panel.js";

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

/** Reads the panel resource and hands back the document the host would load. */
async function readPanel(client: Client): Promise<string> {
    const read = await client.readResource({ uri: PANEL_RESOURCE_URI });
    return String(read.contents[0]?.text);
}

/** The contents of the page's one inline module script. */
function viewScriptOf(html: string): string {
    const match = /<script type="module">\n([\s\S]*?)\n<\/script>/.exec(html);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
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

    test("the page the host loads carries the compiled view script", async () => {
        // The bug this catches is a quiet one: the panel resource reads
        // perfectly, the card markup is all there, and nothing ever renders
        // because the page has no script to run. The document is checked the
        // way a host sees it — over a real client, not through buildPanelHtml.
        await withHost(UI_CAPABLE, async client => {
            const script = viewScriptOf(await readPanel(client));

            expect(script.startsWith(VIEW_SCRIPT_BANNER)).toBe(true);
            // The banner alone would pass on an empty script, so look for the
            // bootstrap itself: the name it introduces the App with, and the
            // element it mounts into. Minification keeps string literals.
            expect(script).toContain("facet-studio-panel");
            expect(script).toContain(PANEL_CONTAINER_ID);
        });
    });

    test("the view script is inline and alone, and asks for nothing from the network", async () => {
        await withHost(UI_CAPABLE, async client => {
            const html = await readPanel(client);

            // One opening tag, one closing tag. A script that closed its own
            // tag early would show up here as a second one, with the rest of
            // the bundle spilling into the document as markup.
            expect(html.match(/<script/g)).toHaveLength(1);
            expect(html.match(/<\/script>/g)).toHaveLength(1);
            expect(html).not.toContain("<script src");

            // The same no-markup rule the renderer follows, checked on the
            // code that actually ships inside the page.
            const script = viewScriptOf(html);
            expect(script).not.toContain("innerHTML");
            expect(script).not.toContain("document.write");
        });
    });

    test("a script that would close its own tag is refused, not inlined", async () => {
        // The guard that makes inlining safe at all. The view script is built
        // code rather than payload, but nothing about the seam enforces that,
        // so the seam keeps checking.
        expect(() => buildPanelHtml({ viewScript: '</script><img src=x onerror="alert(1)">' })).toThrow(
            /Refusing to inline/,
        );
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

// ---------------------------------------------------------------------------
// The seam between a tool result and the card
// ---------------------------------------------------------------------------
//
// Every other panel test writes its own payload, in the panel's own shape. That
// is exactly why the card could go hollow — show "Unknown facet" for every real
// call — with a green suite: the tests were agreeing with themselves.
//
// So nothing below authors a payload. A real client calls a real tool, the CLI
// really runs, and whatever comes back is handed straight to the renderer. The
// only things these tests know up front are the facet name they asked the CLI
// to create and the tool titles the server published to the host — both of
// which reach the card by a different route than the assertion does.

/**
 * Just enough DOM for the renderer to build a card in, and to read it back out
 * of. There is no HTML parsing here; panel.test.ts is where the markup safety
 * of the same renderer is proved.
 */
class CardNode {
    className = "";
    readonly children: CardNode[] = [];
    private text = "";

    constructor(readonly tag: string) {}

    appendChild(child: CardNode): CardNode {
        this.children.push(child);
        return child;
    }

    setAttribute(): void {
        // The header cells carry scope="col"; nothing here needs to read it.
    }

    get textContent(): string {
        return this.children.length === 0 ? this.text : this.children.map(child => child.textContent).join("");
    }

    set textContent(value: string | null) {
        this.children.length = 0;
        this.text = value ?? "";
    }
}

const cardDocument: PanelDocument = {
    createElement: tag => new CardNode(tag) as unknown as PanelElement,
    createTextNode: data => {
        const node = new CardNode("#text");
        node.textContent = data;
        return node;
    },
    createDocumentFragment: () => new CardNode("#fragment") as unknown as PanelFragment,
};

/** Renders a tool result exactly the way the panel does when a host sends it. */
function renderCard(result: unknown): CardNode {
    return renderResult(result, cardDocument) as unknown as CardNode;
}

/** Every element carrying `className`, depth first. */
function byClass(root: CardNode, className: string): CardNode[] {
    const found = root.className.split(" ").includes(className) ? [root] : [];
    return [...found, ...root.children.flatMap(child => byClass(child, className))];
}

/** The text of the first element carrying `className`. */
function textAt(root: CardNode, className: string): string {
    return byClass(root, className)[0]?.textContent ?? "";
}

/** The whole text payload the tool returned — the JSON envelope, verbatim. */
function envelopeOf(result: CallToolResult): string {
    return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/** The title the server published for a tool. The card's operation must match it. */
async function publishedTitle(client: Client, name: string): Promise<string> {
    const listed = await client.listTools();
    const title = listed.tools.find(tool => tool.name === name)?.title;
    expect(title).toBeDefined();
    return String(title);
}

/**
 * A scratch directory under the project root, always cleaned up.
 *
 * It has to live under the root because that is where the tools resolve a
 * `directory` argument, and anything outside it is refused by design.
 */
async function withScratchDirectory(body: (directory: string) => Promise<void>): Promise<void> {
    const directory = mkdtempSync(path.join(realpathSync(process.cwd()), ".facet-seam-"));
    try {
        await body(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

/** Nothing the card shows may be the raw envelope, and no field may be blank. */
function expectNotHollow(card: CardNode, result: CallToolResult): void {
    const whole = card.textContent;
    expect(whole).not.toContain("Unknown facet");
    expect(whole).not.toContain('{"ok":');
    expect(whole).not.toContain('"ok"');
    // Checked against the real payload rather than a guessed prefix, so no
    // change to how the envelope is serialized can let a dump slip through.
    expect(whole).not.toContain(envelopeOf(result));
    expect(textAt(card, "facet")).not.toBe("");
    expect(textAt(card, "operation")).not.toBe("");
}

describe("a real tool result, through the real renderer", () => {
    test("facet_list fills the card in with this project's own identity", async () => {
        await withHost(UI_CAPABLE, async client => {
            const result = (await client.callTool({ name: "facet_list", arguments: {} })) as CallToolResult;
            const card = renderCard(result);

            // There is no facet.json beside these tests, so the CLI has no name
            // to report and the run falls back to the project directory's own
            // name. Still a true one — the card is never left saying nothing.
            expect(textAt(card, "facet")).toBe(path.basename(realpathSync(process.cwd())));
            expect(textAt(card, "operation")).toBe(await publishedTitle(client, "facet_list"));
            expect(textAt(card, "status-text")).toBe("Succeeded");
            expectNotHollow(card, result);
        });
    });

    test("a facet the CLI really built shows its own name and its own assets", async () => {
        await withHost(UI_CAPABLE, async client => {
            await withScratchDirectory(async directory => {
                const result = (await client.callTool({
                    name: "facet_create",
                    arguments: { name: "seam-probe", directory, skills: ["authoring"], agents: ["reviewer"] },
                })) as CallToolResult;
                expect(result.isError).toBeUndefined();

                const card = renderCard(result);

                // "seam-probe" went in as an argument and comes back through the
                // CLI's own output. Nothing between the two was written by hand.
                expect(textAt(card, "facet")).toBe("seam-probe");
                expect(textAt(card, "operation")).toBe(await publishedTitle(client, "facet_create"));
                expect(textAt(card, "status-text")).toBe("Succeeded");

                // Real rows for the files the CLI actually wrote, typed and
                // chipped — the part of the card that was empty before.
                const names = byClass(card, "asset-name").map(cell => cell.textContent);
                expect(names).toContain("authoring");
                expect(names).toContain("reviewer");
                expect(byClass(card, "type-skill").length).toBeGreaterThan(0);
                expect(byClass(card, "type-agent").length).toBeGreaterThan(0);
                expect(byClass(card, "empty")).toHaveLength(0);

                expectNotHollow(card, result);
            });
        });
    });

    test("a failing call shows the CLI's own sentence, never the envelope", async () => {
        await withHost(UI_CAPABLE, async client => {
            await withScratchDirectory(async directory => {
                // An empty directory is not a facet, so this really does fail.
                const result = (await client.callTool({
                    name: "facet_verify",
                    arguments: { directory },
                })) as CallToolResult;
                expect(result.isError).toBe(true);

                const card = renderCard(result);
                expect(textAt(card, "status-text")).toBe("Failed");
                expect(byClass(card, "status-error")).toHaveLength(1);

                // The message is the CLI's: it appears word for word inside the
                // payload the tool returned, and it is not that payload.
                const message = textAt(card, "message");
                expect(message).not.toBe("");
                expect(envelopeOf(result)).toContain(message);
                expect(message.trimStart().startsWith("{")).toBe(false);
                expect(message).not.toContain('"code"');

                expect(textAt(card, "empty")).toBe("No assets reported.");
                expectNotHollow(card, result);
            });
        });
    });
});

// ---------------------------------------------------------------------------
// One registrar failing must not take the rest of the server with it
// ---------------------------------------------------------------------------
//
// Registration happens inside `oninitialized`, where a throw has nowhere to go.
// Before this was contained, one registrar blowing up meant every registrar
// behind it silently never ran, and the host was handed a server missing half
// its surface with nothing said about why.
//
// Making a registrar fail on purpose needs no stubs. The SDK refuses to add a
// capability once a transport is attached, so a capability that was never
// primed before connect is one whose registrar cannot succeed — which is how
// each test below chooses its casualty.

/** Primes the tools listing the way createServer does, so tool registration can work. */
function primeTools(server: McpServer): void {
    server.registerTool("probe", { description: "Removed immediately." }, () => ({ content: [] })).remove();
}

/** A UI-capable host's registration deps, reporting failures into `failures`. */
function depsCollecting(failures: RegistrationFailure[]): RegistrationDeps {
    return {
        clientCapabilities: {},
        uiCapability: {},
        supportsUi: true,
        onRegistrationError: failure => void failures.push(failure),
    };
}

/** Connects a real client to a server built by hand, and always closes both ends. */
async function withBareServer(server: McpServer, body: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: UI_CAPABLE });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        await body(client);
    } finally {
        await client.close();
        await server.close();
    }
}

describe("registration failures", () => {
    test("a registrar that fails does not stop the ones queued behind it", async () => {
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        // Resources primed, tools not: both tool registrars are doomed, and the
        // panel — which runs last — is the one that can still succeed.
        primeResourceListing(server);
        const failures: RegistrationFailure[] = [];

        await withBareServer(server, async client => {
            registerAll(server, depsCollecting(failures));

            expect(failures.map(failure => failure.registrar)).toEqual(["tools", "auth"]);
            // The point of the whole exercise: the panel still ran.
            const listed = await client.listResources();
            expect(listed.resources.map(resource => resource.uri)).toContain(PANEL_RESOURCE_URI);
        });
    });

    test("a failing registrar costs its own surface and nothing else", async () => {
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        // The mirror image: tools primed, resources not, so the panel is the
        // casualty and every tool has to survive it.
        primeTools(server);
        const failures: RegistrationFailure[] = [];

        await withBareServer(server, async client => {
            registerAll(server, depsCollecting(failures));

            expect(failures).toHaveLength(1);
            expect(failures[0]?.registrar).toBe("panel");
            expect(String(failures[0]?.error)).toContain("Cannot register capabilities after connecting");

            const listed = await client.listTools();
            expect(listed.tools.map(tool => tool.name)).toEqual([...EXPECTED_TOOLS]);
        });
    });

    test("a seam that throws outright still leaves a live, reachable server", async () => {
        const failures: RegistrationFailure[] = [];
        const server = createServer({
            registerAll: () => {
                throw new Error("the seam exploded");
            },
            onRegistrationError: failure => void failures.push(failure),
        });

        await withBareServer(server, async client => {
            // The handshake completed rather than tearing the connection down,
            // and the host can still talk to what is there.
            expect(client.getServerVersion()).toMatchObject({ name: "facet-studio" });
            await expect(client.listTools()).resolves.toMatchObject({ tools: [] });

            expect(failures).toHaveLength(1);
            expect(failures[0]?.registrar).toBe("registration");
            expect(String(failures[0]?.error)).toContain("the seam exploded");
        });
    });
});
