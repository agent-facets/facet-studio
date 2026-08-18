// Tests for the registry browse tool.
//
// The important one is the seam test at the bottom. Every other check here works
// on values this file made up, and the panel has been shipped broken before while
// exactly those checks were green — the payloads were hand-written and no tool
// ever emitted them. So the last test calls the real tool over a real client and
// feeds whatever comes back into the real renderer, with nothing hand-authored in
// between except the registry's HTTP response.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browse, registerBrowse, shortDate, toCounts, toGalleryFacet, toText, DEFAULT_LIMIT } from "./browse.js";
import {
    GalleryController,
    renderResult,
    toContentAssets,
    toGalleryData,
    type GalleryAsset,
    type GalleryFacet,
    type PanelDocument,
    type PanelElement,
} from "./view/panel.js";

/** A response shaped exactly like the registry's, captured from the live API. */
const REGISTRY_RESPONSE = {
    facets: [
        {
            name: "worktrunk",
            latest_version: "0.1.0",
            published_at: "2026-07-29T16:32:42.307Z",
            description: "Worktrunk-first git-worktree guidance for coding agents.",
            owner: { kind: "user", username: "julian" },
            publisher: "julian",
            asset_counts: { skills: 1, servers: 0, commands: 1, agents: 0 },
            visibility: "public",
        },
        {
            name: "graphite",
            latest_version: "0.1.0",
            published_at: "2026-07-24T06:46:39.554Z",
            description: "Graphite-first version-control guidance for coding agents.",
            owner: { kind: "user", username: "julian" },
            publisher: "julian",
            asset_counts: { skills: 1, servers: 0, commands: 0, agents: 0 },
            visibility: "public",
        },
    ],
};

describe("normalizing a registry summary", () => {
    test("drops the zero counts and singularizes the rest", () => {
        expect(toCounts({ skills: 1, servers: 0, commands: 3, agents: 0 })).toEqual([
            { type: "skill", label: "1 Skill" },
            { type: "command", label: "3 Commands" },
        ]);
    });

    test("calls a server an MCP, the way the registry does", () => {
        expect(toCounts({ servers: 2 })).toEqual([{ type: "server", label: "2 MCP" }]);
    });

    test("survives a facet with no counts at all", () => {
        expect(toCounts(undefined)).toEqual([]);
        expect(toCounts({})).toEqual([]);
    });

    test("shortens the published date, and shrugs at a bad one", () => {
        expect(shortDate("2026-07-29T16:32:42.307Z")).toBe("Jul 29");
        expect(shortDate("not a date")).toBe("");
        expect(shortDate(undefined)).toBe("");
    });

    test("falls back to the owner when there is no publisher, and says so when there is no description", () => {
        const facet = toGalleryFacet({ name: "x", owner: { username: "ada" } });
        expect(facet.publisher).toBe("ada");
        expect(facet.description).toBe("No description");
        expect(facet.version).toBe("");
    });
});

describe("the text fallback", () => {
    test("names every facet, because a text-only host sees nothing else", async () => {
        const data = await browse({ query: "coding" }, { fetchFacets: async () => REGISTRY_RESPONSE });
        const text = toText(data);
        expect(text).toContain("worktrunk@0.1.0");
        expect(text).toContain("Worktrunk-first git-worktree guidance for coding agents.");
        expect(text).toContain("by julian");
        expect(text).toContain("1 Skill, 1 Command");
        expect(text).toContain("graphite@0.1.0");
    });

    test("says plainly when nothing matched", async () => {
        const data = await browse({ query: "nope" }, { fetchFacets: async () => ({ facets: [] }) });
        expect(toText(data)).toBe("No facets matched nope.");
    });
});

describe("the request", () => {
    test("asks for relevance when there is a query and recency when there is not", async () => {
        const seen: string[] = [];
        const fetchFacets = async (url: string): Promise<unknown> => {
            seen.push(url);
            return { facets: [] };
        };
        await browse({ query: "coding" }, { fetchFacets });
        await browse({}, { fetchFacets });

        expect(seen[0]).toContain("q=coding");
        expect(seen[0]).toContain("sort=relevance");
        expect(seen[1]).not.toContain("q=");
        expect(seen[1]).toContain("sort=recent");
    });

    test("honours a registry override, so a test or a private registry can redirect it", async () => {
        const seen: string[] = [];
        await browse(
            {},
            {
                registryUrl: "https://registry.example.com/",
                fetchFacets: async url => {
                    seen.push(url);
                    return { facets: [] };
                },
            },
        );
        expect(seen[0]).toStartWith("https://registry.example.com/v0/facets");
    });

    test("caps the result count", async () => {
        const many = { facets: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}` })) };
        const data = await browse({}, { fetchFacets: async () => many });
        expect(data.results).toHaveLength(DEFAULT_LIMIT);

        const fewer = await browse({ limit: 2 }, { fetchFacets: async () => many });
        expect(fewer.results).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// The seam: real tool, real client, real renderer
// ---------------------------------------------------------------------------

/** A DOM that records what was built, and throws if anyone reaches for markup. */
class Node {}
class Text extends Node {
    constructor(readonly data: string) {
        super();
    }
}
class Element extends Node {
    className = "";
    children: Node[] = [];
    constructor(readonly tag: string) {
        super();
    }
    appendChild(child: Node): Node {
        this.children.push(child);
        return child;
    }
    attrs = new Map<string, string>();
    handlers: (() => void)[] = [];
    setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
    addEventListener(_type: string, handler: () => void): void { this.handlers.push(handler); }
    click(): void { for (const h of this.handlers) h(); }
    get textContent(): string {
        return text(this);
    }
    set textContent(value: string | null) {
        this.children = value === null || value === "" ? [] : [new Text(value)];
    }
}
for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) {
    Object.defineProperty(Element.prototype, sink, {
        get(): never {
            throw new Error(`the gallery reached for ${sink}`);
        },
        set(): never {
            throw new Error(`the gallery reached for ${sink}`);
        },
    });
}
class Fragment extends Node {
    children: Node[] = [];
    appendChild(child: Node): Node {
        this.children.push(child);
        return child;
    }
}

function text(node: Node): string {
    if (node instanceof Text) return node.data;
    if (node instanceof Element || node instanceof Fragment) return node.children.map(text).join("");
    return "";
}

function classes(node: Node): string[] {
    const found: string[] = [];
    const visit = (current: Node): void => {
        if (current instanceof Element) {
            if (current.className !== "") found.push(current.className);
            current.children.forEach(visit);
        } else if (current instanceof Fragment) {
            current.children.forEach(visit);
        }
    };
    visit(node);
    return found;
}

/** Every element in the tree whose rendered text equals `label`. */
function buttonsLabelled(node: Node, label: string): Element[] {
    const found: Element[] = [];
    const visit = (c: Node): void => {
        if (c instanceof Element) {
            if (c.tag === "button" && text(c).trim() === label) found.push(c);
            c.children.forEach(visit);
        } else if (c instanceof Fragment) {
            c.children.forEach(visit);
        }
    };
    visit(node);
    return found;
}

const testDocument: PanelDocument = {
    createElement: tag => new Element(tag) as unknown as PanelElement,
    createTextNode: data => new Text(data),
    createDocumentFragment: () => new Fragment(),
};

function facetFixture(): GalleryFacet {
    return {
        name: "worktrunk",
        version: "0.1.0",
        description: "Worktrunk-first git-worktree guidance for coding agents.",
        publisher: "julian",
        published: "Jul 29",
        counts: [
            { type: "skill", label: "1 Skill" },
            { type: "command", label: "1 Command" },
        ],
    };
}

function idlePorts(): { install: () => Promise<{ ok: boolean }>; contents: () => Promise<GalleryAsset[]> } {
    return { install: async () => ({ ok: true }), contents: async () => [] };
}

describe("browse end to end, tool result straight into the panel", () => {
    test("what the tool returns is what the gallery draws", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { fetchFacets: async () => REGISTRY_RESPONSE });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_browse", arguments: { query: "coding" } });

        // Nothing is hand-written from here down: the controller is handed the
        // tool result verbatim, exactly as the view script hands it over.
        const gallery = toGalleryData(result);
        expect(gallery).toBeDefined();

        const root = new Element("main");
        const controller = new GalleryController(root as unknown as PanelElement, idlePorts(), testDocument);
        controller.show(gallery!);
        const drawn = text(root);

        expect(drawn).toContain("worktrunk");
        expect(drawn).toContain("Worktrunk-first git-worktree guidance for coding agents.");
        expect(drawn).toContain("by julian");
        expect(drawn).toContain("1 Skill");
        expect(drawn).toContain("1 Command");
        expect(drawn).toContain("Jul 29");
        expect(drawn).toContain("graphite");
        expect(drawn).not.toContain("Unknown facet");

        const drawnClasses = classes(root);
        expect(drawnClasses).toContain("chip type-skill");
        expect(drawnClasses).toContain("chip type-command");
        expect(drawnClasses).not.toContain("chip type-unknown");

        await client.close();
    });

    test("clicking Install runs the tool and the button follows it through", async () => {
        const asked: GalleryFacet[] = [];
        const root = new Element("main");
        const controller = new GalleryController(
            root as unknown as PanelElement,
            {
                install: async facet => {
                    asked.push(facet);
                    return { ok: true };
                },
                contents: async () => [],
            },
            testDocument,
        );
        controller.show({ query: "", results: [facetFixture()] });

        expect(text(root)).toContain("Install");
        buttonsLabelled(root, "Install")[0].click();
        await Bun.sleep(0);

        expect(asked.map(f => f.name)).toEqual(["worktrunk"]);
        expect(controller.snapshot().installs.worktrunk).toBe("installed");
        expect(text(root)).toContain("Installed");
        // A finished install must not still offer to start another one.
        expect(buttonsLabelled(root, "Install")).toHaveLength(0);
    });

    test("a failed install says why and offers a retry", async () => {
        const root = new Element("main");
        const controller = new GalleryController(
            root as unknown as PanelElement,
            {
                install: async () => ({ ok: false, message: "No adapter is installed." }),
                contents: async () => [],
            },
            testDocument,
        );
        controller.show({ query: "", results: [facetFixture()] });

        buttonsLabelled(root, "Install")[0].click();
        await Bun.sleep(0);

        expect(controller.snapshot().installs.worktrunk).toBe("failed");
        expect(text(root)).toContain("No adapter is installed.");
        expect(buttonsLabelled(root, "Retry")).toHaveLength(1);
    });

    test("expanding a card fetches what is inside it, through the real tool", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            fetchFacets: async () => ({
                name: "worktrunk",
                version: "0.1.0",
                manifest_json: JSON.stringify({
                    skills: { "using-worktrunk": { description: "Route worktree work through wt." } },
                    commands: { "/wt-new": { description: "Make a worktree." } },
                }),
            }),
        });
        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const root = new Element("main");
        const controller = new GalleryController(
            root as unknown as PanelElement,
            {
                install: async () => ({ ok: true }),
                // Exactly what bootstrap does: call the tool, read its assets.
                contents: async facet => {
                    const r = await client.callTool({
                        name: "facet_contents",
                        arguments: { name: facet.name, version: facet.version },
                    });
                    return toContentAssets(r) ?? [];
                },
            },
            testDocument,
        );
        controller.show({ query: "", results: [facetFixture()] });

        buttonsLabelled(root, "What is inside")[0].click();
        await Bun.sleep(5);

        const drawn = text(root);
        expect(drawn).toContain("using-worktrunk");
        expect(drawn).toContain("Route worktree work through wt.");
        expect(drawn).toContain("/wt-new");
        expect(buttonsLabelled(root, "Hide contents")).toHaveLength(1);

        await client.close();
    });

    test("filtering narrows the list and can be cleared", () => {
        const root = new Element("main");
        const controller = new GalleryController(root as unknown as PanelElement, idlePorts(), testDocument);
        controller.show({
            query: "",
            results: [
                facetFixture(),
                {
                    name: "agentic",
                    version: "1.0.0",
                    description: "Has an agent.",
                    publisher: "julian",
                    published: "Jul 1",
                    counts: [{ type: "agent", label: "1 Agent" }],
                },
            ],
        });
        expect(text(root)).toContain("worktrunk");
        expect(text(root)).toContain("agentic");

        buttonsLabelled(root, "Agents")[0].click();
        expect(text(root)).toContain("agentic");
        expect(text(root)).not.toContain("worktrunk");

        buttonsLabelled(root, "Everything")[0].click();
        expect(text(root)).toContain("worktrunk");
    });

    test("filtering to nothing offers a way back rather than a blank panel", () => {
        const root = new Element("main");
        const controller = new GalleryController(root as unknown as PanelElement, idlePorts(), testDocument);
        controller.show({ query: "", results: [facetFixture()] });

        buttonsLabelled(root, "MCP")[0].click();
        expect(text(root)).toContain("No facet in these results carries that.");
        buttonsLabelled(root, "Show everything")[0].click();
        expect(text(root)).toContain("worktrunk");
    });

    test("a registry that is down produces an error, not an empty gallery", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            fetchFacets: async () => {
                throw new Error("connect ECONNREFUSED");
            },
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = (await client.callTool({ name: "facet_browse", arguments: {} })) as {
            isError?: boolean;
            content: { text: string }[];
        };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Could not reach the registry");
        // An error must not be mistaken for a gallery with nothing in it.
        expect(toGalleryData(result)).toBeUndefined();

        await client.close();
    });

    test("an empty result set draws the empty state, not a blank panel", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { fetchFacets: async () => ({ facets: [] }) });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_browse", arguments: { query: "zzz" } });
        const root = new Element("main");
        const controller = new GalleryController(root as unknown as PanelElement, idlePorts(), testDocument);
        controller.show(toGalleryData(result)!);
        expect(text(root)).toContain("Nothing matched zzz.");

        await client.close();
    });
});
