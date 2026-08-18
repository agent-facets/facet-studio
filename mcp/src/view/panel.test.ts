// Tests for the Facet Studio result panel.
//
// The panel is the one place where arbitrary tool output becomes a web page, so
// most of what follows is about that boundary. Two independent checks back the
// XSS claim: a DOM harness that refuses to expose any markup-parsing sink at all,
// and a re-parse of the rendered output with Bun's HTMLRewriter — a real HTML
// parser — to confirm no element ever came out of a payload string.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ASSET_ACCENTS } from "./tokens.js";
import type { RegistrationDeps } from "../server.js";
import {
    buildPanelHtml,
    mount,
    PANEL_RESOURCE_URI,
    primeResourceListing,
    registerPanel,
    renderResult,
    TOKENS_MARKER,
    VIEW_SCRIPT_MARKER,
    type PanelDocument,
    type PanelElement,
} from "./panel.js";

// ---------------------------------------------------------------------------
// A deliberately unhelpful DOM
// ---------------------------------------------------------------------------
//
// It models exactly three things: elements, text nodes and fragments. There is
// no HTML parsing anywhere in it, and the properties a careless renderer would
// reach for throw on sight — so a regression can't quietly pass these tests.

class TestNode {}

class TestText extends TestNode {
    constructor(readonly data: string) {
        super();
    }
}

class TestFragment extends TestNode {
    readonly children: TestNode[] = [];

    appendChild(child: TestNode): TestNode {
        this.children.push(child);
        return child;
    }
}

class TestElement extends TestNode {
    className = "";
    readonly attributes = new Map<string, string>();
    children: TestNode[] = [];

    constructor(readonly tag: string) {
        super();
    }

    appendChild(child: TestNode): TestNode {
        this.children.push(child);
        return child;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    get textContent(): string {
        return rawText(this);
    }

    /** Assigning text replaces the children — the only sanctioned data path. */
    set textContent(value: string | null) {
        this.children = value === null || value === "" ? [] : [new TestText(value)];
    }
}

for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) {
    Object.defineProperty(TestElement.prototype, sink, {
        get(): never {
            throw new Error(`panel.ts reached for ${sink}`);
        },
        set(): never {
            throw new Error(`panel.ts reached for ${sink}`);
        },
    });
}

function createTestDocument(): PanelDocument {
    return {
        createElement: tag => new TestElement(tag) as unknown as PanelElement,
        createTextNode: data => new TestText(data),
        createDocumentFragment: () => new TestFragment(),
    };
}

/** The text a person would read, undecorated and unescaped. */
function rawText(node: TestNode): string {
    if (node instanceof TestText) {
        return node.data;
    }
    if (node instanceof TestElement || node instanceof TestFragment) {
        return node.children.map(rawText).join("");
    }
    return "";
}

function escapeText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
    return escapeText(value).replaceAll('"', "&quot;");
}

/** Serializes the tree the way a browser would, so a parser can check it. */
function serialize(node: TestNode): string {
    if (node instanceof TestText) {
        return escapeText(node.data);
    }
    if (node instanceof TestFragment) {
        return node.children.map(serialize).join("");
    }
    if (!(node instanceof TestElement)) {
        return "";
    }
    const attributes = [
        ...(node.className === "" ? [] : [`class="${escapeAttribute(node.className)}"`]),
        ...[...node.attributes].map(([name, value]) => `${name}="${escapeAttribute(value)}"`),
    ];
    const open = [node.tag, ...attributes].join(" ");
    return `<${open}>${node.children.map(serialize).join("")}</${node.tag}>`;
}

/** Every element in the tree carrying the given class. */
function byClass(node: TestNode, className: string): TestElement[] {
    const found: TestElement[] = [];
    const visit = (current: TestNode): void => {
        if (current instanceof TestElement) {
            if (current.className.split(" ").includes(className)) {
                found.push(current);
            }
            current.children.forEach(visit);
        } else if (current instanceof TestFragment) {
            current.children.forEach(visit);
        }
    };
    visit(node);
    return found;
}

/** How many `selector` elements a real HTML parser finds in this markup. */
function countElements(html: string, selector: string): number {
    let count = 0;
    new HTMLRewriter().on(selector, { element: () => void count++ }).transform(html);
    return count;
}

/** The text inside every `selector` element, in document order. */
function textOfEach(html: string, selector: string): string[] {
    const found: string[] = [];
    new HTMLRewriter()
        .on(selector, {
            element: () => void found.push(""),
            text: chunk => {
                found[found.length - 1] += chunk.text;
            },
        })
        .transform(html);
    return found;
}

/** Every attribute name a real HTML parser finds in this markup. */
function attributeNames(html: string): string[] {
    const names = new Set<string>();
    new HTMLRewriter()
        .on("*", {
            element(node) {
                for (const [name] of node.attributes) {
                    names.add(name);
                }
            },
        })
        .transform(html);
    return [...names].sort();
}

function render(data: unknown): { tree: TestNode; html: string } {
    const tree = renderResult(data, createTestDocument()) as unknown as TestNode;
    return { tree, html: serialize(tree) };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const SUCCESS_RESULT = {
    structuredContent: {
        facet: "facet-studio",
        operation: "build",
        status: "success",
        message: "Verified 13 entries.",
        assets: [
            { type: "skill", name: "authoring", detail: "Authoring guide" },
            { type: "agent", name: "facet-author" },
        ],
    },
};

const ERROR_RESULT = {
    isError: true,
    content: [{ type: "text", text: "facet.json is malformed at line 3" }],
};

/**
 * What a lifecycle tool writes into its text part.
 *
 * This is the payload, not the summary the card is drawn from. Normally both
 * arrive and the summary wins; these cover the fallback, for a host or proxy
 * that passes the text along and drops the structured content. The end-to-end
 * check of the normal path lives in integration.test.ts, against a tool result
 * nobody wrote by hand.
 */
const ENVELOPE_FAILURE = {
    isError: true,
    content: [
        {
            type: "text",
            text: JSON.stringify(
                { ok: false, error: { code: "cli_failed", message: "facet.json is malformed at line 3" } },
                null,
                2,
            ),
        },
    ],
};

const ENVELOPE_SUCCESS = {
    content: [{ type: "text", text: JSON.stringify({ ok: true, data: { name: "facet-studio" } }, null, 2) }],
};

/** What the sign-in tools return: prose, plus structured data that is not a card summary. */
const AUTH_RESULT = {
    structuredContent: { signedIn: false, mode: "fallback", registryUrl: "https://example.test" },
    content: [{ type: "text", text: "facet studio · not signed in\n\nNo registry credential found." }],
};

const XSS_PAYLOAD = "<img src=x onerror=alert(1)>";

// ---------------------------------------------------------------------------

describe("renderResult", () => {
    test("draws a branded card for a successful operation", () => {
        const { tree, html } = render(SUCCESS_RESULT);

        expect(byClass(tree, "operation")[0]?.textContent).toBe("build");
        expect(byClass(tree, "facet")[0]?.textContent).toBe("facet-studio");
        expect(byClass(tree, "status-success")).toHaveLength(1);
        expect(byClass(tree, "status-text")[0]?.textContent).toBe("Succeeded");
        expect(byClass(tree, "message")[0]?.textContent).toBe("Verified 13 entries.");

        // Two asset rows, each chipped with its own brand color class.
        expect(byClass(tree, "asset-name").map(cell => cell.textContent)).toEqual(["authoring", "facet-author"]);
        expect(byClass(tree, "type-skill")).toHaveLength(1);
        expect(byClass(tree, "type-agent")).toHaveLength(1);
        // A missing detail shows an em dash rather than "undefined".
        expect(byClass(tree, "asset-detail").map(cell => cell.textContent)).toEqual(["Authoring guide", "—"]);
        expect(countElements(html, "table.assets tbody tr")).toBe(2);
    });

    test("draws the failure state and the error text a tool returned", () => {
        const { tree } = render(ERROR_RESULT);

        expect(byClass(tree, "status-error")).toHaveLength(1);
        expect(byClass(tree, "status-text")[0]?.textContent).toBe("Failed");
        expect(byClass(tree, "message")[0]?.textContent).toBe("facet.json is malformed at line 3");
        // Nothing to list, and the card says so instead of showing an empty table.
        expect(byClass(tree, "empty")[0]?.textContent).toBe("No assets reported.");
    });

    test("labels the asset columns the way the presentation skill does", () => {
        // The skill mandates Type | Name | Description, and the card and the
        // prose fallback have to describe a result with the same words.
        expect(textOfEach(render(SUCCESS_RESULT).html, "table.assets thead th")).toEqual([
            "Type",
            "Name",
            "Description",
        ]);
    });

    test("reads the tools' own envelope when no card summary arrives", () => {
        const failure = render(ENVELOPE_FAILURE);
        expect(byClass(failure.tree, "status-text")[0]?.textContent).toBe("Failed");
        expect(byClass(failure.tree, "message")[0]?.textContent).toBe("facet.json is malformed at line 3");

        // `data` names the facet, so the card does too rather than shrugging.
        const success = render(ENVELOPE_SUCCESS);
        expect(byClass(success.tree, "facet")[0]?.textContent).toBe("facet-studio");
        expect(byClass(success.tree, "status-text")[0]?.textContent).toBe("Succeeded");
    });

    test("never puts the payload dump on the card", () => {
        // The failure this catches is the ugly one: a card whose message is a
        // pretty-printed `{ "ok": false, ... }` instead of the CLI's sentence.
        for (const result of [ENVELOPE_FAILURE, ENVELOPE_SUCCESS]) {
            const text = rawText(render(result).tree);
            expect(text).not.toContain('"ok"');
            expect(text).not.toContain("{");
        }
    });

    test("still renders the sign-in tools' results, which carry no card summary", () => {
        const { tree } = render(AUTH_RESULT);
        expect(byClass(tree, "status-text")[0]?.textContent).toBe("Succeeded");
        expect(byClass(tree, "message")[0]?.textContent).toContain("No registry credential found.");
        expect(byClass(tree, "empty")[0]?.textContent).toBe("No assets reported.");
    });

    test("renders a markup payload as inert text, everywhere it can appear", () => {
        const { tree, html } = render({
            structuredContent: {
                facet: XSS_PAYLOAD,
                operation: XSS_PAYLOAD,
                message: XSS_PAYLOAD,
                assets: [{ type: XSS_PAYLOAD, name: XSS_PAYLOAD, detail: XSS_PAYLOAD }],
            },
        });

        // Control: the same string, handed to the parser directly, IS an element.
        // That is what makes the assertions below meaningful.
        expect(countElements(XSS_PAYLOAD, "img")).toBe(1);

        // Parsed back by a real HTML parser, the rendered card contains none.
        expect(countElements(html, "img")).toBe(0);
        expect(countElements(html, "script")).toBe(0);
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(html).not.toContain("<img");

        // And it is still readable text, not a mangled escape.
        expect(byClass(tree, "facet")[0]?.textContent).toBe(XSS_PAYLOAD);
        expect(byClass(tree, "message")[0]?.textContent).toBe(XSS_PAYLOAD);
        expect(byClass(tree, "asset-detail")[0]?.textContent).toBe(XSS_PAYLOAD);
    });

    test("keeps payload strings out of class names", () => {
        const { tree, html } = render({
            structuredContent: {
                assets: [
                    { type: "constructor", name: "a" },
                    { type: "__proto__", name: "b" },
                    { type: 'x" onload="alert(1)', name: "c" },
                ],
            },
        });

        // Only the four brand asset types get their own class; inherited object
        // property names must not be mistaken for known types.
        expect(byClass(tree, "type-unknown")).toHaveLength(3);
        expect(html).not.toContain("type-constructor");

        // A quote in a payload can't open an attribute either: parsed back, the
        // whole card carries only the attributes the renderer meant to set.
        expect(attributeNames(html)).toEqual(["class", "scope"]);

        // The raw types are still shown to the reader, as text.
        expect(byClass(tree, "chip").map(chip => chip.textContent)).toEqual([
            "constructor",
            "__proto__",
            'x" onload="alert(1)',
        ]);
    });

    test("survives input that is nothing like a tool result", () => {
        for (const junk of [null, undefined, "hello", 42, [], { structuredContent: [] }]) {
            const { tree } = render(junk);
            expect(byClass(tree, "facet")[0]?.textContent).toBe("Unknown facet");
            expect(byClass(tree, "operation")[0]?.textContent).toBe("Result");
        }
    });

    test("mount swaps the old card out without parsing anything", () => {
        const doc = createTestDocument();
        const container = doc.createElement("main");

        mount(container, SUCCESS_RESULT, doc);
        mount(container, ERROR_RESULT, doc);

        const tree = container as unknown as TestNode;
        expect(byClass(tree, "card")).toHaveLength(1);
        expect(byClass(tree, "status-error")).toHaveLength(1);
        expect(byClass(tree, "status-success")).toHaveLength(0);
    });
});

describe("buildPanelHtml", () => {
    const html = buildPanelHtml();

    test("inlines the brand tokens for both themes", () => {
        expect(html).toContain(":root {");
        expect(html).toContain("--bg: #0a0a12;");
        expect(html).toContain('html[data-theme="light"]');
        expect(html).toContain("--bg: #f6f4ef;");
        // The panel paints its own background, so host chrome can't wash it out.
        expect(html).toContain("background: var(--bg);");
    });

    test("inlines the asset-type accents from the registry token set", () => {
        for (const [type, color] of Object.entries(ASSET_ACCENTS)) {
            expect(html).toContain(`--asset-${type}: ${color};`);
            expect(html).toContain(`.type-${type} .dot { background: var(--asset-${type}); }`);
        }
        expect(html).toContain("--status-success: var(--ok);");
    });

    test("uses the registry's accents, not the brand package's", () => {
        // The registry and the brand package disagree, and the registry wins here:
        // #8b5cf6 as small text is 4.39:1 on an elevated card, and the brand's
        // inkFaint is 3.75:1 as body text. Tracked upstream as
        // `brand-light-accents-fail-contrast`.
        expect(html).toContain("--accent-skill: #a78bfa;");
        expect(html).toContain("--accent-agent: #f472b6;");
        expect(html).toContain("--ink-faint: #8583a8;");
        expect(html).not.toContain("--ink-faint: #6a6890;");
    });

    test("carries a light theme whose accents are readable as text", () => {
        expect(html).toContain("--accent-skill: #5b21b6;");
        expect(html).toContain("--accent-agent: #9f1239;");
        expect(html).toContain("--ok: #166534;");
    });

    test("asks nothing of the network", () => {
        expect(html).not.toMatch(/https?:/i);
        expect(html).not.toContain("//fonts");
        expect(html).not.toContain("@import");
        expect(html).not.toContain("url(");
        expect(html).not.toContain("<link");
        expect(html).toContain('id="facet-panel"');
        // Both placeholders were consumed.
        expect(html).not.toContain(TOKENS_MARKER);
        expect(html).not.toContain(VIEW_SCRIPT_MARKER);
    });

    test("has a style rule for every class the renderer emits", () => {
        const rendered = new Set<string>();
        new HTMLRewriter()
            .on("*", {
                element(node) {
                    for (const name of (node.getAttribute("class") ?? "").split(" ").filter(Boolean)) {
                        rendered.add(name);
                    }
                },
            })
            .transform(render(SUCCESS_RESULT).html);

        // Catches the drift where panel.ts starts emitting a class panel.html
        // never styles, which would quietly unbrand the card.
        const unstyled = [...rendered].filter(name => !new RegExp(`\\.${name}(?![\\w-])`).test(html));
        expect(unstyled).toEqual([]);
        expect(rendered.size).toBeGreaterThan(8);
    });

    test("leaves out the view script unless a build step supplies one", () => {
        expect(html).not.toContain("<script");
        expect(buildPanelHtml({ viewScript: "console.log('hi')" })).toContain(
            "<script type=\"module\">\nconsole.log('hi')\n</script>",
        );
        // A `$&` in the script must survive intact, not get expanded.
        expect(buildPanelHtml({ viewScript: "const a = '$&';" })).toContain("const a = '$&';");
    });

    test("refuses input that would break out of the tag it is nested in", () => {
        expect(() => buildPanelHtml({ viewScript: "</script><img src=x onerror=alert(1)>" })).toThrow(
            /closes its own tag/,
        );
        expect(() => buildPanelHtml({ shell: "<html></html>" })).toThrow(/missing the <!--facet:tokens--> placeholder/);
    });
});

describe("registerPanel", () => {
    const UI_DEPS: RegistrationDeps = { clientCapabilities: {}, uiCapability: {}, supportsUi: true };

    test("serves the panel to a real client at the spec URI and MIME type", async () => {
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        // Same trick server.ts uses for tools: the capability has to exist before
        // the handshake, but the registration itself happens after it.
        primeResourceListing(server);
        server.server.oninitialized = () => void registerPanel(server, UI_DEPS);

        const client = new Client(
            { name: "test-host", version: "0.0.0" },
            { capabilities: { extensions: { [EXTENSION_ID]: {} } } },
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        try {
            expect(client.getServerCapabilities()?.resources).toBeDefined();
            const listed = await client.listResources();
            expect(listed.resources.map(resource => resource.uri)).toContain(PANEL_RESOURCE_URI);

            const read = await client.readResource({ uri: PANEL_RESOURCE_URI });
            const contents = read.contents[0];
            expect(contents?.uri).toBe(PANEL_RESOURCE_URI);
            expect(contents?.mimeType).toBe(RESOURCE_MIME_TYPE);
            expect(contents?.mimeType).toBe("text/html;profile=mcp-app");
            expect(String(contents?.text)).toContain('id="facet-panel"');
        } finally {
            await client.close();
            await server.close();
        }
    });

    test("registers nothing for a host that cannot render UI", () => {
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        const registered = registerPanel(server, { ...UI_DEPS, uiCapability: undefined, supportsUi: false });
        expect(registered).toBeUndefined();
    });

    test("without the priming call, a post-handshake registration cannot work", async () => {
        // This is why primeResourceListing exists: the SDK installs the resources
        // capability on first registration and refuses to add capabilities once a
        // transport is attached, so the panel would never reach the host.
        const server = new McpServer({ name: "facet-studio", version: "0.2.0" });
        let failure: unknown;
        server.server.oninitialized = () => {
            try {
                registerPanel(server, UI_DEPS);
            } catch (error) {
                failure = error;
            }
        };

        const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        try {
            expect(client.getServerCapabilities()?.resources).toBeUndefined();
            expect(String(failure)).toContain("Cannot register capabilities after connecting");
        } finally {
            await client.close();
            await server.close();
        }
    });
});
