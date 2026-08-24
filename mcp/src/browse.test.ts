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
import { browse, clip, countLine, registerBrowse, shortDate, toCounts, toGalleryFacet, toText, DEFAULT_LIMIT, MAX_LIMIT } from "./browse.js";
import type { InstalledData, InstalledFacet } from "./project.js";
import {
    ConsoleController,
    toDetailData,
    toGalleryData,
    toPanelData,
    toReadmeData,
    type GalleryFacet,
    type PanelElement,
} from "./view/panel.js";
import { PANEL_PAYLOAD_KEY } from "./view/dom.js";
import {
    buttonsLabelled,
    classes,
    root,
    stubPorts,
    testDocument,
    text,
    type Element,
} from "./view/harness.js";

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

    test("carries an install marker for an installed row, and none for the rest", async () => {
        const data = await browse(
            { query: "coding" },
            {
                fetchFacets: async () => REGISTRY_RESPONSE,
                readProjectFn: async () => installedData([installedFacet({ name: "worktrunk", version: "0.1.0" })]),
            },
        );
        const text = toText(data);
        expect(text).toContain("worktrunk@0.1.0 · by julian — Worktrunk-first git-worktree guidance for coding agents. (1 Skill, 1 Command) · installed 0.1.0");
        // graphite is not installed in this fixture, so its line carries no marker.
        const graphiteLine = text.split("\n").find(line => line.startsWith("- graphite"));
        expect(graphiteLine).not.toContain("· installed");
        expect(graphiteLine).not.toContain("· update available");
    });

    test("shows an update-available marker when the locked version trails the registry's latest", async () => {
        const data = await browse(
            { query: "coding" },
            {
                fetchFacets: async () => REGISTRY_RESPONSE,
                readProjectFn: async () => installedData([installedFacet({ name: "worktrunk", version: "0.0.9" })]),
            },
        );
        expect(toText(data)).toContain("· update available: 0.0.9 → 0.1.0");
    });

    test("ends with a more-results line when nextCursor is present, and omits it otherwise", async () => {
        const withCursor = await browse(
            { query: "coding" },
            { fetchFacets: async () => ({ ...REGISTRY_RESPONSE, next_cursor: "page2" }) },
        );
        expect(toText(withCursor)).toEndWith("More results available — search again with the cursor to page further.");

        const withoutCursor = await browse({ query: "coding" }, { fetchFacets: async () => REGISTRY_RESPONSE });
        expect(toText(withoutCursor)).not.toContain("More results available");
    });
});

describe("clip", () => {
    test("a 150-char sentence clips at a word boundary, ≤120 chars, ending …", () => {
        const long =
            "This is a sentence about a facet that runs long enough to definitely exceed the summary row's strict one hundred twenty character budget for clipping.";
        expect(long.length).toBe(150);
        const clipped = clip(long, 120);
        expect(clipped.length).toBeLessThanOrEqual(120);
        expect(clipped.endsWith("…")).toBe(true);
        // Cut at a word boundary: what's left (minus the ellipsis) is a clean prefix of the source.
        expect(long.startsWith(clipped.slice(0, -1))).toBe(true);
        expect(clipped.slice(0, -1).endsWith(" ")).toBe(false);
    });

    test("an exactly-120-char description passes through untouched", () => {
        const exact =
            "Exactly one hundred and twenty characters long, this fixture description must survive clip() completely untouched today.";
        expect(exact.length).toBe(120);
        expect(clip(exact, 120)).toBe(exact);
    });

    test("a short description passes through untouched", () => {
        expect(clip("Short.", 120)).toBe("Short.");
    });
});

describe("countLine", () => {
    test("renders counts as one compact, comma-joined line", () => {
        expect(countLine(toCounts({ skills: 2, commands: 1 }))).toBe("2 Skills, 1 Command");
    });

    test("renders no counts as an empty line", () => {
        expect(countLine([])).toBe("");
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

    test("a query that matches nothing falls back to everything published, in the same call", async () => {
        // The registry's search is literal; a phrase can miss a catalog that is
        // all about it. An empty answer would just provoke a second browse from
        // the caller — and a second widget — so this one call does the retry.
        const everything = { facets: [{ name: "worktrunk" }, { name: "graphite" }] };
        const asked: string[] = [];
        const data = await browse(
            { query: "dev workflow management" },
            {
                fetchFacets: async url => {
                    asked.push(url);
                    return url.includes("q=") ? { facets: [] } : everything;
                },
            },
        );

        expect(asked).toHaveLength(2);
        expect(data.fallback).toBe(true);
        expect(data.query).toBe("dev workflow management");
        expect(data.results.map(facet => facet.name)).toEqual(["worktrunk", "graphite"]);
        // And the text-only rendering says what happened.
        expect(toText(data)).toContain("Nothing matched dev workflow management");
    });

    test("a hit skips the fallback, and an empty registry stays empty", async () => {
        const asked: string[] = [];
        const hit = await browse(
            { query: "worktrunk" },
            {
                fetchFacets: async url => {
                    asked.push(url);
                    return { facets: [{ name: "worktrunk" }] };
                },
            },
        );
        expect(asked).toHaveLength(1);
        expect(hit.fallback).toBe(false);

        // No query and no facets: there is nothing to fall back to.
        const empty = await browse({}, { fetchFacets: async () => ({ facets: [] }) });
        expect(empty.fallback).toBe(false);
        expect(empty.results).toEqual([]);
    });

    test("an oversized limit is clamped, not refused", async () => {
        // A host's model asking for 50 is asking for "plenty", and the answer
        // to that is the cap — never a validation error it can't act on.
        const many = { facets: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}` })) };
        const clamped = await browse({ limit: 50 }, { fetchFacets: async () => many });
        expect(clamped.results).toHaveLength(MAX_LIMIT);
    });

    test("type filter keeps only facets with that asset type", async () => {
        const data = await browse(
            { type: "skill" },
            {
                fetchFacets: async () => ({
                    facets: [
                        { name: "has-skill", asset_counts: { skills: 1, agents: 0 } },
                        { name: "only-agent", asset_counts: { skills: 0, agents: 1 } },
                    ],
                }),
            },
        );
        expect(data.results.map(f => f.name)).toEqual(["has-skill"]);
        expect(data.type).toBe("skill");
    });

    test("type filter composes with query", async () => {
        const asked: string[] = [];
        const data = await browse(
            { query: "coding", type: "command" },
            {
                fetchFacets: async (url: string) => {
                    asked.push(url);
                    return {
                        facets: [
                            { name: "has-cmd", asset_counts: { commands: 2 } },
                            { name: "no-cmd", asset_counts: { skills: 1 } },
                        ],
                    };
                },
            },
        );
        expect(asked[0]).toContain("q=coding");
        expect(data.results.map(f => f.name)).toEqual(["has-cmd"]);
        expect(data.type).toBe("command");
    });

    test("type filter with fallback applies to fallback results", async () => {
        const asked: string[] = [];
        const fallbackFacets = [
            { name: "agent-facet", asset_counts: { agents: 1 } },
            { name: "skill-facet", asset_counts: { skills: 1 } },
        ];
        const data = await browse(
            { query: "impossible phrase", type: "agent" },
            {
                fetchFacets: async (url: string) => {
                    asked.push(url);
                    // First call: query with specific phrase returns nothing
                    if (url.includes("q=")) return { facets: [] };
                    // Second call: fallback returns everything
                    return { facets: fallbackFacets };
                },
            },
        );
        expect(asked).toHaveLength(2);
        expect(data.fallback).toBe(true);
        expect(data.results.map(f => f.name)).toEqual(["agent-facet"]);
        expect(data.type).toBe("agent");
    });

    test("cursor input appears in the fetched URL", async () => {
        const asked: string[] = [];
        const cursor = "eyJxIjoiZ2l0In0";
        await browse(
            { query: "git", cursor },
            {
                fetchFacets: async (url: string) => {
                    asked.push(url);
                    return { facets: [{ name: "git-tool" }] };
                },
            },
        );
        expect(asked[0]).toContain(`cursor=${encodeURIComponent(cursor)}`);
    });

    test("an empty cursor is rejected by the schema at the tool layer", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { fetchFacets: async () => ({ facets: [] }) });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = (await client.callTool({
            name: "facet_browse",
            arguments: { cursor: "" },
        })) as { isError?: boolean; content: { text: string }[] };

        expect(result.isError).toBe(true);

        await client.close();
    });

    test("a response with next_cursor yields payload.nextCursor", async () => {
        const cursor = "nextpage123";
        const data = await browse(
            { query: "git" },
            {
                fetchFacets: async () => ({
                    facets: [{ name: "git-tool" }],
                    next_cursor: cursor,
                }),
            },
        );
        expect(data.nextCursor).toBe(cursor);
    });

    test("a response without next_cursor yields no nextCursor key at all", async () => {
        const data = await browse(
            { query: "git" },
            {
                fetchFacets: async () => ({
                    facets: [{ name: "git-tool" }],
                }),
            },
        );
        expect("nextCursor" in data).toBe(false);
    });

    test("zero-hit fallback drops the cursor from the request but includes nextCursor if registry sends one", async () => {
        const asked: string[] = [];
        const cursor = "oldcursor";
        const data = await browse(
            { query: "impossible phrase", cursor },
            {
                fetchFacets: async (url: string) => {
                    asked.push(url);
                    // First call: query with cursor returns nothing
                    if (url.includes("q=")) return { facets: [] };
                    // Second call: fallback (no cursor sent) returns everything with next_cursor
                    return { facets: [{ name: "result" }], next_cursor: "fallback_cursor" };
                },
            },
        );
        expect(asked).toHaveLength(2);
        // First call should have cursor
        expect(asked[0]).toContain(`cursor=${encodeURIComponent(cursor)}`);
        // Second call (fallback) should not have cursor in the URL
        expect(asked[1]).not.toContain("cursor=");
        // Fallback results SHOULD include nextCursor from the fallback fetch
        expect(data.nextCursor).toBe("fallback_cursor");
    });
});

// ---------------------------------------------------------------------------
// Joining the project's own install state onto the registry rows
// ---------------------------------------------------------------------------

/** One `InstalledFacet`, filled in with plausible defaults for the fields a case doesn't care about. */
function installedFacet(overrides: Partial<InstalledFacet> & { name: string }): InstalledFacet {
    return {
        scope: "",
        shortName: overrides.name,
        declared: "latest",
        version: "",
        origin: "registry",
        from: "",
        installed: true,
        assets: [],
        counts: [],
        ...overrides,
    };
}

/** A minimal `InstalledData`, the shape `readProject` returns. */
function installedData(facets: InstalledFacet[], declared = true): InstalledData {
    return {
        kind: "installed",
        project: "test-project",
        directory: "/test-project",
        rootLabel: "configured",
        declared,
        locked: facets.length > 0,
        facets,
        drift: [],
    };
}

describe("joining the project's install state onto the registry rows", () => {
    test("an installed facet at the same version carries its version and no update", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({ facets: [{ name: "worktrunk", latest_version: "1.3.0" }] }),
                readProjectFn: async () => installedData([installedFacet({ name: "worktrunk", version: "1.3.0" })]),
            },
        );
        expect(data.results[0].installed).toEqual({ version: "1.3.0", updateAvailable: false });
    });

    test("a locked version behind the registry's latest offers an update", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({ facets: [{ name: "worktrunk", latest_version: "1.3.0" }] }),
                readProjectFn: async () => installedData([installedFacet({ name: "worktrunk", version: "1.2.0" })]),
            },
        );
        expect(data.results[0].installed).toEqual({ version: "1.2.0", updateAvailable: true });
    });

    test("declared but never installed gets no key — Install is still the right button", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({ facets: [{ name: "worktrunk", latest_version: "1.3.0" }] }),
                readProjectFn: async () =>
                    installedData([installedFacet({ name: "worktrunk", installed: false, version: "" })]),
            },
        );
        expect("installed" in data.results[0]).toBe(false);
    });

    test("a scoped name survives the join untouched — no shortName stripping", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({
                    facets: [{ name: "@agentfacets/address-pr-feedback", latest_version: "2.0.0" }],
                }),
                readProjectFn: async () =>
                    installedData([
                        installedFacet({ name: "@agentfacets/address-pr-feedback", version: "2.0.0", scope: "@agentfacets/", shortName: "address-pr-feedback" }),
                    ]),
            },
        );
        expect(data.results[0].installed).toEqual({ version: "2.0.0", updateAvailable: false });
    });

    test("a broken project degrades to registry-only rows — browse still succeeds", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({ facets: [{ name: "worktrunk", latest_version: "1.3.0" }] }),
                readProjectFn: async () => {
                    throw new Error("no facets.json readable");
                },
            },
        );
        expect("installed" in data.results[0]).toBe(false);
    });

    test("no facets.json at all — declared: false — also yields no key", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({ facets: [{ name: "worktrunk", latest_version: "1.3.0" }] }),
                readProjectFn: async () => installedData([], false),
            },
        );
        expect("installed" in data.results[0]).toBe(false);
    });

    test("a name absent from the project's facets also gets no key", async () => {
        const data = await browse(
            {},
            {
                fetchFacets: async () => ({ facets: [{ name: "worktrunk", latest_version: "1.3.0" }] }),
                readProjectFn: async () => installedData([installedFacet({ name: "other-facet", version: "1.0.0" })]),
            },
        );
        expect("installed" in data.results[0]).toBe(false);
    });

    test("no readProjectFn override — the real readProject runs and, off in a scratch worktree, yields no key", async () => {
        const data = await browse({}, { fetchFacets: async () => ({ facets: [{ name: "worktrunk" }] }) });
        // No assertion on presence either way: whatever this checkout's own facets.json
        // says is not this test's business. The point is that browse resolves without
        // readProjectFn being supplied at all — the real default runs, not undefined.
        expect(data.results).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// The seam: real tool, real client, real console
// ---------------------------------------------------------------------------

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

/** A console showing a gallery, without going through a tool call to get there. */
function showing(results: GalleryFacet[], ports = stubPorts()): { root: Element; console: ConsoleController } {
    const mount = root();
    const console_ = new ConsoleController(mount as unknown as PanelElement, ports, testDocument);
    const payload = { kind: "gallery", query: "", results };
    console_.show(payload, toPanelData(payload, { operation: "Browse facets" }));
    return { root: mount, console: console_ };
}

describe("browse end to end, tool result straight into the console", () => {
    test("what the tool returns is what the gallery draws", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { fetchFacets: async () => REGISTRY_RESPONSE });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_browse", arguments: { query: "coding" } });

        // Nothing is hand-written from here down: the console is handed the tool
        // result verbatim, exactly as the view script hands it over.
        expect(toGalleryData(result)).toBeDefined();

        const mount = root();
        const console_ = new ConsoleController(mount as unknown as PanelElement, stubPorts(), testDocument);
        console_.show(result, toPanelData(result, { operation: "Browse facets" }));
        const drawn = text(mount);

        expect(drawn).toContain("worktrunk");
        expect(drawn).toContain("Worktrunk-first git-worktree guidance for coding agents.");
        expect(drawn).toContain("by julian");
        expect(drawn).toContain("1 Skill");
        expect(drawn).toContain("1 Command");
        expect(drawn).toContain("Jul 29");
        expect(drawn).toContain("graphite");
        expect(drawn).not.toContain("Unknown facet");

        const drawnClasses = classes(mount);
        expect(drawnClasses).toContain("chip type-skill");
        expect(drawnClasses).toContain("chip type-command");
        expect(drawnClasses).not.toContain("chip type-unknown");

        await client.close();
    });

    test("clicking Install runs facet_add and the button follows it through", async () => {
        const asked: string[] = [];
        const { root: mount, console: console_ } = showing([facetFixture()], stubPorts({
            add: async name => {
                asked.push(name);
                return { ok: true };
            },
        }));

        expect(text(mount)).toContain("Install");
        buttonsLabelled(mount, "Install")[0].click();
        await Bun.sleep(0);

        expect(asked).toEqual(["worktrunk"]);
        expect(console_.snapshot().gallery.installs.worktrunk).toBe("installed");
        expect(text(mount)).toContain("Installed");
        // A finished install must not still offer to start another one.
        expect(buttonsLabelled(mount, "Install")).toHaveLength(0);
    });

    test("a failed install says why and offers a retry", async () => {
        const { root: mount, console: console_ } = showing([facetFixture()], stubPorts({
            add: async () => ({ ok: false, message: "No adapter is installed." }),
        }));

        buttonsLabelled(mount, "Install")[0].click();
        await Bun.sleep(0);

        expect(console_.snapshot().gallery.installs.worktrunk).toBe("failed");
        expect(text(mount)).toContain("No adapter is installed.");
        expect(buttonsLabelled(mount, "Retry")).toHaveLength(1);
    });

    test("opening a card fetches the facet's detail through the real tool", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            fetchFacets: async (url: string) => {
                if (url.endsWith("/versions/0.1.0")) {
                    return { name: "worktrunk", version: "0.1.0", versions: ["0.0.9", "0.1.0"] };
                }
                return {
                    name: "worktrunk",
                    version: "0.1.0",
                    publisher: "julian",
                    published_at: "2026-07-29T16:32:42.307Z",
                    asset_counts: { skills: 1, commands: 1 },
                    manifest_json: JSON.stringify({
                        skills: { "using-worktrunk": { description: "Route worktree work through wt." } },
                        commands: { "wt-new": { description: "Make a worktree." } },
                    }),
                };
            },
        });
        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const { root: mount } = showing([facetFixture()], stubPorts({
            // Exactly what bootstrap does: call the tool, read the screen out of it.
            detail: async (name, version) => {
                const r = await client.callTool({
                    name: "facet_detail",
                    arguments: version === undefined ? { name } : { name, version },
                });
                return toDetailData(r);
            },
        }));

        buttonsLabelled(mount, "What is inside")[0].click();
        await Bun.sleep(5);

        const drawn = text(mount);
        expect(drawn).toContain("using-worktrunk");
        expect(drawn).toContain("Route worktree work through wt.");
        expect(drawn).toContain("wt-new");
        expect(buttonsLabelled(mount, "← Registry")).toHaveLength(1);

        await client.close();
    });

    test("filtering narrows the list and can be cleared", () => {
        const { root: mount } = showing([
            facetFixture(),
            {
                name: "agentic",
                version: "1.0.0",
                description: "Has an agent.",
                publisher: "julian",
                published: "Jul 1",
                counts: [{ type: "agent", label: "1 Agent" }],
            },
        ]);
        expect(text(mount)).toContain("worktrunk");
        expect(text(mount)).toContain("agentic");

        buttonsLabelled(mount, "Agents")[0].click();
        expect(text(mount)).toContain("agentic");
        expect(text(mount)).not.toContain("worktrunk");

        buttonsLabelled(mount, "Everything")[0].click();
        expect(text(mount)).toContain("worktrunk");
    });

    test("filtering to nothing offers a way back rather than a blank panel", () => {
        const { root: mount } = showing([facetFixture()]);

        buttonsLabelled(mount, "MCP")[0].click();
        expect(text(mount)).toContain("No facet in these results carries that.");
        buttonsLabelled(mount, "Show everything")[0].click();
        expect(text(mount)).toContain("worktrunk");
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
        const mount = root();
        const console_ = new ConsoleController(mount as unknown as PanelElement, stubPorts(), testDocument);
        console_.show(result, toPanelData(result, { operation: "Browse facets" }));
        expect(text(mount)).toContain("Nothing matched zzz.");

        await client.close();
    });

    test("an invalid type is refused by the schema at the tool layer", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { fetchFacets: async () => ({ facets: [] }) });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = (await client.callTool({
            name: "facet_browse",
            arguments: { type: "banana" },
        })) as { isError?: boolean; content: { text: string }[] };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("skill");
        expect(result.content[0].text).toContain("agent");
        expect(result.content[0].text).toContain("command");
        expect(result.content[0].text).toContain("server");

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// The envelope: apps hosts get a summary up front and the real payload in
// _meta; text hosts see today's shape, unchanged.
// ---------------------------------------------------------------------------

describe("the envelope splits by who's asking", () => {
    test("(a) apps host: facet_browse's structuredContent is a bounded row summary with enough per facet to answer without another call, the real gallery rides in _meta, and the panel's own reader still reconstructs it", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { supportsUi: true, fetchFacets: async () => REGISTRY_RESPONSE });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = (await client.callTool({ name: "facet_browse", arguments: { query: "coding" } })) as Record<string, unknown>;
        const structured = result.structuredContent as Record<string, unknown>;
        expect(structured.kind).toBe("gallery-summary");
        expect(structured.names).toBeUndefined();
        const facets = structured.facets as { name: string; version: string; description: string; counts: string }[];
        expect(facets).toEqual([
            {
                name: "worktrunk",
                version: "0.1.0",
                description: "Worktrunk-first git-worktree guidance for coding agents.",
                counts: "1 Skill, 1 Command",
            },
            {
                name: "graphite",
                version: "0.1.0",
                description: "Graphite-first version-control guidance for coding agents.",
                counts: "1 Skill",
            },
        ]);

        const meta = result._meta as Record<string, unknown>;
        const payload = (meta[PANEL_PAYLOAD_KEY] as Record<string, unknown>).payload as Record<string, unknown>;
        expect(payload.kind).toBe("gallery");

        // The seam: the real reader, not a hand-checked shape, reconstructs the gallery.
        const gallery = toGalleryData(result);
        expect(gallery?.results.map(f => f.name)).toEqual(["worktrunk", "graphite"]);

        await client.close();
    });

    test("an installed facet's row carries the installed object; an uninstalled one carries no installed key at all", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            supportsUi: true,
            fetchFacets: async () => REGISTRY_RESPONSE,
            readProjectFn: async () => installedData([installedFacet({ name: "worktrunk", version: "0.1.0" })]),
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = (await client.callTool({ name: "facet_browse", arguments: { query: "coding" } })) as Record<string, unknown>;
        const structured = result.structuredContent as Record<string, unknown>;
        const facets = structured.facets as { name: string; installed?: { version: string; updateAvailable: boolean } }[];
        expect(facets[0].installed).toEqual({ version: "0.1.0", updateAvailable: false });
        expect("installed" in facets[1]).toBe(false);

        await client.close();
    });

    test("nextCursor rides in both the apps-host summary and the payload when the registry sends one, and in neither when it doesn't", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            supportsUi: true,
            fetchFacets: async () => ({ facets: [{ name: "git-tool" }], next_cursor: "page2" }),
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const withCursor = (await client.callTool({ name: "facet_browse", arguments: { query: "git" } })) as Record<string, unknown>;
        const summaryWithCursor = withCursor.structuredContent as Record<string, unknown>;
        expect(summaryWithCursor.nextCursor).toBe("page2");
        const metaWithCursor = withCursor._meta as Record<string, unknown>;
        const payloadWithCursor = (metaWithCursor[PANEL_PAYLOAD_KEY] as Record<string, unknown>).payload as Record<string, unknown>;
        expect(payloadWithCursor.nextCursor).toBe("page2");

        await client.close();
    });

    test("nextCursor is absent from both the apps-host summary and the payload when the registry sends none", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            supportsUi: true,
            fetchFacets: async () => ({ facets: [{ name: "git-tool" }] }),
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = (await client.callTool({ name: "facet_browse", arguments: { query: "git" } })) as Record<string, unknown>;
        const summary = result.structuredContent as Record<string, unknown>;
        expect("nextCursor" in summary).toBe(false);
        const meta = result._meta as Record<string, unknown>;
        const payload = (meta[PANEL_PAYLOAD_KEY] as Record<string, unknown>).payload as Record<string, unknown>;
        expect("nextCursor" in payload).toBe(false);

        await client.close();
    });

    test("(b) text-only host: facet_browse keeps today's byte-identical shape — full gallery in structuredContent, no _meta payload", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { fetchFacets: async () => REGISTRY_RESPONSE });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = (await client.callTool({ name: "facet_browse", arguments: { query: "coding" } })) as Record<string, unknown>;
        const structured = result.structuredContent as Record<string, unknown>;
        expect(structured.kind).toBe("gallery");
        expect(result._meta).toBeUndefined();

        await client.close();
    });

    test("(c) an apps-host result with _meta stripped out matches no reader — the fall-through property", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, { supportsUi: true, fetchFacets: async () => REGISTRY_RESPONSE });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = (await client.callTool({ name: "facet_browse", arguments: { query: "coding" } })) as Record<string, unknown>;
        const stripped = { ...result, _meta: undefined };
        expect(toGalleryData(stripped)).toBeUndefined();

        await client.close();
    });

    test("(d) facet_detail and facet_readme carry the same split, and toReadmeData gets its first coverage", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        registerBrowse(server, {
            supportsUi: true,
            fetchFacets: async (url: string) => {
                if (url.endsWith("/versions/0.1.0")) {
                    return { name: "worktrunk", version: "0.1.0", versions: ["0.0.9", "0.1.0"] };
                }
                if (url.endsWith("/contents")) {
                    return { files: [{ kind: "text", path: "README.md", content: "# Worktrunk\nSetup details." }] };
                }
                return {
                    name: "worktrunk",
                    version: "0.1.0",
                    description: "Worktrunk-first git-worktree guidance for coding agents.",
                    publisher: "julian",
                    published_at: "2026-07-29T16:32:42.307Z",
                    asset_counts: { skills: 1, commands: 1 },
                    manifest_json: JSON.stringify({
                        skills: { "using-worktrunk": { description: "Route worktree work through wt." } },
                    }),
                };
            },
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const detailResult = (await client.callTool({
            name: "facet_detail",
            arguments: { name: "worktrunk", version: "0.1.0" },
        })) as Record<string, unknown>;
        const detailStructured = detailResult.structuredContent as Record<string, unknown>;
        expect(detailStructured.kind).toBe("detail-summary");
        expect(JSON.stringify(detailStructured)).not.toContain("description");
        const detailMeta = detailResult._meta as Record<string, unknown>;
        const detailPayload = (detailMeta[PANEL_PAYLOAD_KEY] as Record<string, unknown>).payload as Record<string, unknown>;
        expect(detailPayload.kind).toBe("detail");
        const detailData = toDetailData(detailResult);
        expect(detailData?.description).toBe("Worktrunk-first git-worktree guidance for coding agents.");

        const readmeResult = (await client.callTool({
            name: "facet_readme",
            arguments: { name: "worktrunk", version: "0.1.0" },
        })) as Record<string, unknown>;
        const readmeStructured = readmeResult.structuredContent as Record<string, unknown>;
        expect(readmeStructured.kind).toBe("readme-summary");
        expect(JSON.stringify(readmeStructured)).not.toContain("description");
        const readmeMeta = readmeResult._meta as Record<string, unknown>;
        const readmePayload = (readmeMeta[PANEL_PAYLOAD_KEY] as Record<string, unknown>).payload as Record<string, unknown>;
        expect(readmePayload.kind).toBe("readme");
        const readmeData = toReadmeData(readmeResult);
        expect(readmeData?.text).toContain("Setup details.");

        await client.close();
    });

    test("facet_contents without version resolves latest via the registry", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        const urls: string[] = [];
        registerBrowse(server, {
            fetchFacets: async (url: string) => {
                urls.push(url);
                if (url.includes("/latest-version")) {
                    return { name: "worktrunk", latest: "0.1.0" };
                }
                return {
                    name: "worktrunk",
                    version: "0.1.0",
                    manifest_json: JSON.stringify({
                        skills: { "my-skill": { description: "A skill" } },
                    }),
                };
            },
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_contents", arguments: { name: "worktrunk" } });
        expect(urls.some(u => u.includes("/latest-version"))).toBe(true);
        expect(urls.some(u => u.includes("/0.1.0"))).toBe(true);

        const contentsData = result.structuredContent as Record<string, unknown>;
        expect(contentsData.version).toBe("0.1.0");
        expect((contentsData.assets as unknown[]).length).toBe(1);

        await client.close();
    });

    test("facet_contents with version does not fetch latest-version", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        const urls: string[] = [];
        registerBrowse(server, {
            fetchFacets: async (url: string) => {
                urls.push(url);
                if (url.includes("/latest-version")) {
                    throw new Error("Should not fetch latest-version when version is provided");
                }
                return {
                    name: "worktrunk",
                    version: "0.0.9",
                    manifest_json: JSON.stringify({
                        skills: { "old-skill": { description: "An old skill" } },
                    }),
                };
            },
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_contents", arguments: { name: "worktrunk", version: "0.0.9" } });
        expect(urls.some(u => u.includes("/latest-version"))).toBe(false);
        expect(urls.some(u => u.includes("/0.0.9"))).toBe(true);

        const contentsData = result.structuredContent as Record<string, unknown>;
        expect(contentsData.version).toBe("0.0.9");

        await client.close();
    });

    test("facet_readme without version resolves latest via the registry", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        const urls: string[] = [];
        registerBrowse(server, {
            fetchFacets: async (url: string) => {
                urls.push(url);
                if (url.includes("/latest-version")) {
                    return { name: "worktrunk", latest: "0.1.0" };
                }
                return {
                    files: [{ kind: "text", path: "README.md", content: "# Worktrunk" }],
                };
            },
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_readme", arguments: { name: "worktrunk" } });
        expect(urls.some(u => u.includes("/latest-version"))).toBe(true);
        expect(urls.some(u => u.includes("/0.1.0"))).toBe(true);

        const readmeData = result.structuredContent as Record<string, unknown>;
        expect(readmeData.version).toBe("0.1.0");

        await client.close();
    });

    test("facet_readme with version does not fetch latest-version", async () => {
        const server = new McpServer({ name: "test", version: "0" });
        const urls: string[] = [];
        registerBrowse(server, {
            fetchFacets: async (url: string) => {
                urls.push(url);
                if (url.includes("/latest-version")) {
                    throw new Error("Should not fetch latest-version when version is provided");
                }
                return {
                    files: [{ kind: "text", path: "README.md", content: "# Old version" }],
                };
            },
        });

        const client = new Client({ name: "test-client", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.callTool({ name: "facet_readme", arguments: { name: "worktrunk", version: "0.0.9" } });
        expect(urls.some(u => u.includes("/latest-version"))).toBe(false);
        expect(urls.some(u => u.includes("/0.0.9"))).toBe(true);

        const readmeData = result.structuredContent as Record<string, unknown>;
        expect(readmeData.version).toBe("0.0.9");

        await client.close();
    });
});
