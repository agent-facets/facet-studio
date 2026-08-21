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
    NOT_SERVING,
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
    "facet_browse",
    "facet_contents",
    "facet_detail",
    "facet_readme",
    "facet_project",
    "facet_manifest",
    "facet_capabilities",
    "facet_login",
    "facet_whoami",
] as const;

/** The tools that come from ./browse rather than the lifecycle spec table. */
const BROWSE_TOOLS = ["facet_browse", "facet_contents", "facet_detail", "facet_readme"] as const;

/** The two project reads, from ./project and ./authoring. */
const PROJECT_TOOLS = ["facet_project", "facet_manifest"] as const;

/** The self-report from ./capabilities: what the host negotiated. */
const CAPABILITY_TOOLS = ["facet_capabilities"] as const;

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
        expect([
            ...TOOL_SPECS.map(spec => spec.name),
            ...BROWSE_TOOLS,
            ...PROJECT_TOOLS,
            ...CAPABILITY_TOOLS,
            ...AUTH_TOOLS,
        ]).toEqual([...EXPECTED_TOOLS]);
        expect(EXPECTED_TOOLS).toHaveLength(18);
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
        // Naming the root is what separates "I looked and found nothing" from
        // "nobody told me where to look". This test is about the card, so it
        // says where the project is and lets the read succeed; the refusal has
        // its own test below.
        const previous = process.env.FACET_PROJECT_ROOT;
        process.env.FACET_PROJECT_ROOT = process.cwd();
        try {
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
        } finally {
            if (previous === undefined) delete process.env.FACET_PROJECT_ROOT;
            else process.env.FACET_PROJECT_ROOT = previous;
        }
    });

    test("an unconfirmed root reports itself instead of an empty facet list", async () => {
        // The defect this replaces: a host that starts the server in a scratch
        // directory got `declared: false, facets: []` back and read it as "this
        // project has no facets". The answer now names the directory it read
        // and says nobody supplied a workspace root.
        const previous = process.env.FACET_PROJECT_ROOT;
        const previousClaude = process.env.CLAUDE_PROJECT_DIR;
        delete process.env.FACET_PROJECT_ROOT;
        delete process.env.CLAUDE_PROJECT_DIR;
        try {
            await withHost(TEXT_ONLY, async client => {
                const result = (await client.callTool({ name: "facet_list", arguments: {} })) as CallToolResult;
                const text = String((result.content as { text?: string }[])[0]?.text ?? "");

                // An error, not data. A caller that treats this as a result
                // would be right back to reporting an absence it never checked.
                expect(result.isError).toBe(true);
                expect(text).toContain("No workspace root was supplied");
                expect(text).toContain(realpathSync(process.cwd()));
                expect(text).toContain("FACET_PROJECT_ROOT");
            });
        } finally {
            if (previous !== undefined) process.env.FACET_PROJECT_ROOT = previous;
            if (previousClaude !== undefined) process.env.CLAUDE_PROJECT_DIR = previousClaude;
        }
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
// A server that cannot register its surface must not serve
// ---------------------------------------------------------------------------
//
// Registration runs inside `oninitialized`, after the handshake has already
// been answered, so the connection itself can no longer be refused. What the
// server can do — and now does — is refuse to answer. The failure mode being
// replaced here was the expensive one: a host connects, the handshake looks
// healthy, `tools/list` comes back empty, and nothing anywhere says why.
//
// Two layers, kept apart on purpose, and the tests below check them separately:
//
//   * `registerAll` still gives every registrar its turn and still reports each
//     one that threw, so the diagnostic is complete — then it propagates a
//     single error naming all of them instead of returning as if nothing broke.
//   * `createServer` owns the policy. Any failure reaching it and the server
//     stops answering: every request comes back with the reason.
//
// Making a registrar fail on purpose needs no stubs. The SDK refuses to add a
// capability once a transport is attached, so a capability that was never
// primed before connect is one whose registrar cannot succeed — which is how
// the first two tests choose their casualty.

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
async function withBareServer(
    server: McpServer,
    body: (client: Client) => Promise<void>,
    capabilities: ClientCapabilities = UI_CAPABLE,
): Promise<void> {
    const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        await body(client);
    } finally {
        await client.close();
        await server.close();
    }
}

/**
 * Runs the seam and hands back the error it propagated. Returning normally is
 * itself the bug these tests exist to catch, so that fails on the spot.
 */
function seamFailure(server: McpServer, deps: RegistrationDeps): unknown {
    try {
        registerAll(server, deps);
    } catch (error) {
        return error;
    }
    throw new Error("registerAll returned normally when it should have propagated a failure");
}

describe("registration failures", () => {
    test("every registrar gets its turn, and the propagated error names each casualty", async () => {
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        // Resources primed, tools not: both tool registrars are doomed, and the
        // panel — which runs last — is the one that can still succeed.
        primeResourceListing(server);
        const failures: RegistrationFailure[] = [];

        await withBareServer(server, async client => {
            const error = seamFailure(server, depsCollecting(failures));

            expect(failures.map(failure => failure.registrar)).toEqual([
                "tools",
                "browse",
                "project",
                "authoring",
                "capabilities",
                "auth",
            ]);
            // One error, both casualties named in it, so whoever sees only the
            // throw still learns everything the per-registrar reports said.
            expect(String(error)).toContain("tools registrar");
            expect(String(error)).toContain("auth registrar");
            expect(String(error)).not.toContain("panel registrar");

            // Why each registrar is still contained: the panel got its turn.
            const listed = await client.listResources();
            expect(listed.resources.map(resource => resource.uri)).toContain(PANEL_RESOURCE_URI);
        });
    });

    test("the propagated error carries the reason, not just the registrar's name", async () => {
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        // The mirror image: tools primed, resources not, so the panel is the
        // casualty and every tool registers fine behind it.
        primeTools(server);
        const failures: RegistrationFailure[] = [];

        await withBareServer(server, async client => {
            const error = seamFailure(server, depsCollecting(failures));

            expect(failures).toHaveLength(1);
            expect(failures[0]?.registrar).toBe("panel");
            expect(String(failures[0]?.error)).toContain("Cannot register capabilities after connecting");
            // Which registrar, and why, both readable off the one thrown error.
            expect(String(error)).toContain("panel registrar");
            expect(String(error)).toContain("Cannot register capabilities after connecting");

            // This server was assembled by hand, not by createServer, so nothing
            // has shut it down: the seam's job is to report and propagate, and
            // deciding to stop serving belongs to createServer alone.
            const listed = await client.listTools();
            expect(listed.tools.map(tool => tool.name)).toEqual([...EXPECTED_TOOLS]);
        });
    });

    test("a seam that throws outright leaves a server that refuses to answer, and says why", async () => {
        const failures: RegistrationFailure[] = [];
        const server = createServer({
            registerAll: () => {
                throw new Error("the seam exploded");
            },
            onRegistrationError: failure => void failures.push(failure),
        });

        await withBareServer(server, async client => {
            // The handshake still completes — it was answered before
            // registration ever ran, and there is no taking that back.
            expect(client.getServerVersion()).toMatchObject({ name: "facet-studio" });

            // What must never happen again: an empty tool list served as if it
            // were the truth. Every advertised surface now answers with the
            // reason instead, and the reason reaches the host word for word.
            await expect(client.listTools()).rejects.toThrow(NOT_SERVING);
            await expect(client.listTools()).rejects.toThrow(/the seam exploded/);
            await expect(client.callTool({ name: "facet_list", arguments: {} })).rejects.toThrow(/the seam exploded/);
            await expect(client.listResources()).rejects.toThrow(/the seam exploded/);
            await expect(client.readResource({ uri: PANEL_RESOURCE_URI })).rejects.toThrow(/the seam exploded/);

            expect(failures).toHaveLength(1);
            expect(failures[0]?.registrar).toBe("registration");
            expect(String(failures[0]?.error)).toContain("the seam exploded");
        });
    });

    test("a half-registered surface is refused too, not served in part", async () => {
        // The case the policy is really about. Something did register before the
        // throw, so the server has a surface it could serve — and serving it is
        // the worst outcome of the three, because it looks complete and isn't.
        const server = createServer({
            registerAll: target => {
                target.registerTool("facet_half", { description: "Registered before the failure." }, () => ({
                    content: [],
                }));
                throw new Error("no keyring");
            },
            onRegistrationError: () => {},
        });

        await withBareServer(server, async client => {
            await expect(client.listTools()).rejects.toThrow(/no keyring/);
            await expect(client.callTool({ name: "facet_half", arguments: {} })).rejects.toThrow(/no keyring/);
        });
    });

    test("a text-only host is not a registration failure", async () => {
        // The gate that must survive the new policy. The panel registrar returns
        // without registering anything when the host cannot render UI — that is
        // the capability handshake working, not a broken registrar, and the
        // server owes this host every tool it has.
        const failures: RegistrationFailure[] = [];
        const server = createServer({ onRegistrationError: failure => void failures.push(failure) });

        await withBareServer(
            server,
            async client => {
                const listed = await client.listTools();
                expect(listed.tools.map(tool => tool.name)).toEqual([...EXPECTED_TOOLS]);

                const resources = await client.listResources();
                expect(resources.resources.map(resource => resource.uri)).not.toContain(PANEL_RESOURCE_URI);

                expect(failures).toEqual([]);
            },
            TEXT_ONLY,
        );
    });

    test("a throwing reporter cannot leave a partially registered server serviceable", async () => {
        // Telling someone about the failure used to happen before refusing to
        // serve, so a reporter that threw took the refusal down with it and left
        // this half-built surface open. Refusal goes in first now, and the news
        // is best-effort — the registrar's failure is still what the host hears.
        const server = createServer({
            registerAll: target => {
                target.registerTool("facet_half", { description: "Registered before the failure." }, () => ({
                    content: [],
                }));
                throw new Error("no keyring");
            },
            onRegistrationError: () => {
                throw new Error("telemetry down");
            },
        });

        await withBareServer(server, async client => {
            await expect(client.listTools()).rejects.toThrow(NOT_SERVING);
            await expect(client.listTools()).rejects.toThrow(/no keyring/);
            await expect(client.listTools()).rejects.not.toThrow(/telemetry down/);
            await expect(client.callTool({ name: "facet_half", arguments: {} })).rejects.toThrow(/no keyring/);
        });
    });

    test("a throwing reporter cannot swallow the casualties the seam propagates", async () => {
        // The seam's own report loop, which is the other place a reporter gets
        // called. An unguarded throw there ends the loop and flies out in place
        // of the aggregate below, so the caller hears about telemetry and never
        // learns which registrars actually died.
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        primeResourceListing(server);

        await withBareServer(server, async () => {
            const error = seamFailure(server, {
                clientCapabilities: {},
                uiCapability: {},
                supportsUi: true,
                onRegistrationError: () => {
                    throw new Error("telemetry down");
                },
            });

            expect(String(error)).toContain("tools registrar");
            expect(String(error)).toContain("auth registrar");
            expect(String(error)).not.toContain("telemetry down");
        });
    });

    test("a throwing reporter cannot rewrite the refusal the real seam produces", async () => {
        // Both call sites at once, over the production seam: the tools registrar
        // is doomed by a name already taken, so the real registerAll reports (and
        // is thrown at by the reporter) before createServer installs the refusal.
        // What the host reads must name the collision, not the telemetry.
        const server = createServer({
            onRegistrationError: () => {
                throw new Error("telemetry down");
            },
        });
        server.registerTool("facet_list", { description: "Squatting on a real tool's name." }, () => ({ content: [] }));

        await withBareServer(server, async client => {
            await expect(client.listTools()).rejects.toThrow(NOT_SERVING);
            await expect(client.listTools()).rejects.toThrow(/tools registrar/);
            await expect(client.listTools()).rejects.toThrow(/facet_list is already registered/);
            await expect(client.listTools()).rejects.not.toThrow(/telemetry down/);
        });
    });
});
