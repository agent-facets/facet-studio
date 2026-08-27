// Panel envelope seam test: all five enveloped reads, both client capability
// sets, real readers proving the contract end to end.
//
// This is the regression net for the whole panel seam. We connect a real
// server over in-memory transport to two real clients — one that advertises
// the MCP Apps UI extension, one that doesn't — call all five enveloped tools
// (facet_browse, facet_detail, facet_readme, facet_project, facet_manifest),
// and feed the raw results into the REAL view readers (toGalleryData and
// friends). If a reader can't make sense of what a tool actually sent back,
// the whole seam is broken, and this is what catches it.
//
// One thing worth saying out loud: none of the reconstructed structures below
// carry a `kind` field. `kind` lives on the envelope (structuredContent, or
// the payload tucked into `_meta`) as the discriminator the readers key off —
// it never survives into what a reader hands back. Assertions on a reader's
// output check real fields (query, results, facet, file, directory, name...),
// never `kind`.

import { afterAll, describe, expect, test } from "bun:test";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "./server.js";
import { registerBrowse } from "./browse.js";
import { registerProject, readProject, type InstalledData } from "./project.js";
import { registerAuthoring } from "./authoring.js";
import { PANEL_PAYLOAD_KEY } from "./view/dom.js";
import { toGalleryData, toDetailData, toReadmeData, toInstalledData, toAuthorData } from "./view/panel.js";

const UI_CAPABLE: ClientCapabilities = { extensions: { [EXTENSION_ID]: {} } };
const TEXT_ONLY: ClientCapabilities = {};

/** Temp directories this file made, cleaned up once every test has run. */
const scratchDirs: string[] = [];

function scratch(): string {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "facet-seam-")));
    scratchDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of scratchDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Writes the three fixture files an installed/authoring project carries:
 * `facets.json` and `facets.lock` for facet_project, `facet.json` for
 * facet_manifest — mirroring the mkdtemp fixtures in view/console.test.ts.
 */
function writeProjectFixtures(dir: string): void {
    writeFileSync(
        path.join(dir, "facets.json"),
        JSON.stringify({ manifestVersion: 0.1, facets: { "demo-facet": "1.2.0" } }),
    );
    writeFileSync(
        path.join(dir, "facets.lock"),
        JSON.stringify({
            lockfileVersion: 0.3,
            facets: {
                "demo-facet": {
                    version: "1.2.0",
                    source: { kind: "registry", registry: "https://api.agentfacets.io" },
                    assets: [{ scope: "project", type: "skill", name: "demo-skill" }],
                },
            },
        }),
    );
    writeFileSync(
        path.join(dir, "facet.json"),
        JSON.stringify({
            name: "demo-facet",
            version: "1.2.0",
            description: "A demo facet used by the seam test.",
            skills: { "demo-skill": { description: "Does the demo thing." } },
        }),
    );
}

/**
 * Canned answers for every registry URL the browse-family tools touch: search
 * (with a skill-bearing facet and an agent-only one, so a type filter has
 * something to prove), the single-facet detail lookup, its latest-version and
 * version-history lookups, and its README contents. Shapes mirror the stubs
 * in browse.test.ts.
 */
function makeFetchFacets(includeNextCursor = true): (url: string) => Promise<unknown> {
    return async (url: string): Promise<unknown> => fetchFacetsImpl(url, includeNextCursor);
}

async function fetchFacetsImpl(url: string, includeNextCursor = true): Promise<unknown> {
    if (url.includes("/v0/facets/")) {
        if (url.endsWith("/contents")) {
            return {
                files: [{ kind: "text", path: "README.md", content: "# Test Facet\n\nDetails about the test facet." }],
            };
        }
        if (/\/versions\/[^/]+$/.test(url)) {
            return { versions: ["1.0.0", "0.9.0"] };
        }
        if (url.endsWith("/latest-version")) {
            return { name: "test-facet", latest: "1.0.0" };
        }
        // The single-facet detail endpoint: /v0/facets/<name>/<version>.
        return {
            name: "test-facet",
            version: "1.0.0",
            published_at: "2026-08-21T00:00:00Z",
            description: "A test facet for the seam.",
            owner: { username: "test-user" },
            publisher: "test-user",
            asset_counts: { skills: 1, servers: 0, commands: 0, agents: 0 },
            visibility: "public",
            manifest_json: JSON.stringify({ skills: { "demo-skill": { description: "A demo skill." } } }),
        };
    }
    if (url.includes("/v0/facets")) {
        // The search endpoint.
        const result: { facets: Array<{ name: string; latest_version: string; published_at: string; description: string; owner: { username: string }; asset_counts: Record<string, number>; visibility: string }>; next_cursor?: string } = {
            facets: [
                {
                    name: "skill-facet",
                    latest_version: "1.0.0",
                    published_at: "2026-08-21T00:00:00Z",
                    description: "A facet that carries a skill.",
                    owner: { username: "tester" },
                    asset_counts: { skills: 1, agents: 0, commands: 0, servers: 0 },
                    visibility: "public",
                },
                {
                    name: "agent-facet",
                    latest_version: "1.0.0",
                    published_at: "2026-08-21T00:00:00Z",
                    description: "A facet that carries only an agent.",
                    owner: { username: "tester" },
                    asset_counts: { skills: 0, agents: 1, commands: 0, servers: 0 },
                    visibility: "public",
                },
            ],
        };
        if (includeNextCursor) {
            result.next_cursor = "page2_token";
        }
        return result;
    }
    throw new Error(`Unexpected URL: ${url}`);
}

interface Harness {
    client: Client;
    close: () => Promise<void>;
}

/**
 * A real client talking to a real server over the SDK's in-memory transports,
 * wired the way tools.test.ts's connect() does: registerAll swapped out for a
 * seam that only registers the three enveloped registrars this test seam
 * needs, each handed the negotiated deps plus its own test-only collaborator.
 */
async function connect(
    capabilities: ClientCapabilities,
    projectRoot: string,
    fetchFacetsOverride?: (url: string) => Promise<unknown>,
    installedFacets?: Record<string, string>,
): Promise<Harness> {
    const server = createServer({
        registerAll: (target, deps) => {
            registerBrowse(target, {
                ...deps,
                fetchFacets: fetchFacetsOverride ?? makeFetchFacets(),
                readProjectFn: installedFacets !== undefined ? makeMockReadProjectFn(installedFacets) : undefined,
            });
            registerProject(target, { ...deps, projectRoot });
            registerAuthoring(target, { ...deps, projectRoot });
        },
    });

    const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities });
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

/** Pulls the parts of a tool result every assertion below cares about. */
function extractResult(result: unknown): { content: string; structuredContent: Record<string, unknown>; meta?: Record<string, unknown> } {
    const typed = result as {
        content?: { type: string; text: string }[];
        structuredContent?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
    };
    return {
        content: typed.content?.[0]?.text ?? "",
        structuredContent: typed.structuredContent ?? {},
        meta: typed._meta,
    };
}

/**
 * Creates a mock readProject with the given facets already installed.
 *
 * It returns a whole `InstalledData`, not just the two fields the browse join
 * reads, so that a change to readProject's shape breaks this stub loudly here
 * rather than being papered over at the call site.
 */
function makeMockReadProjectFn(installedFacets: Record<string, string>): typeof readProject {
    return async (_directory, _deps): Promise<InstalledData> => {
        return {
            kind: "installed",
            project: "seam-fixture",
            directory: "/seam-fixture",
            rootLabel: "test fixture",
            declared: true,
            locked: true,
            facets: Object.entries(installedFacets).map(([name, version]) => ({
                name,
                scope: name.startsWith("@") ? `${name.split("/")[0]}/` : "",
                shortName: name.startsWith("@") ? (name.split("/")[1] ?? name) : name,
                declared: version,
                version,
                origin: "registry",
                from: "test fixture",
                installed: true,
                assets: [],
                counts: [],
            })),
            drift: [],
        };
    };
}

/** Asserts a string carries no "description" substring, case-insensitive. */
function assertNoDescription(text: string): void {
    expect(text.toLowerCase()).not.toContain("description");
}

describe("panel envelope seam", () => {
    describe("facet_browse", () => {
        test("UI client gets a summary and a payload in _meta; text-only gets the full payload", async () => {
            const projectRoot = scratch();
            const uiHarness = await connect(UI_CAPABLE, projectRoot);
            const textHarness = await connect(TEXT_ONLY, projectRoot);
            try {
                const uiResult = await uiHarness.client.callTool({ name: "facet_browse", arguments: { query: "test" } });
                const textResult = await textHarness.client.callTool({ name: "facet_browse", arguments: { query: "test" } });

                const ui = extractResult(uiResult);
                const text = extractResult(textResult);

                expect(ui.structuredContent.kind).toBe("gallery-summary");
                const names = ui.structuredContent.names as string[];
                expect(Array.isArray(names)).toBe(true);
                expect(names.length).toBeGreaterThan(0);
                expect(typeof names[0]).toBe("string");
                // The summary is the one surface a recitation could come from,
                // so it holds nothing worth reciting.
                expect(ui.structuredContent.facets).toBeUndefined();
                assertNoDescription(JSON.stringify(ui.structuredContent));
                expect(ui.meta).toBeDefined();
                expect((ui.meta?.[PANEL_PAYLOAD_KEY] as { payload?: unknown })?.payload).toBeDefined();
                expect(ui.content).toContain("panel");

                expect(text.structuredContent.kind).toBe("gallery");
                expect(text.meta).toBeUndefined();
                expect(text.content).toContain("skill-facet");
                expect(text.content).toContain("A facet that carries a skill.");
            } finally {
                await uiHarness.close();
                await textHarness.close();
            }
        });

        test("the type filter narrows the real results, and the UI reader reconstructs them", async () => {
            const projectRoot = scratch();
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const result = await harness.client.callTool({ name: "facet_browse", arguments: { query: "test", type: "skill" } });
                const ui = extractResult(result);
                expect(ui.structuredContent.type).toBe("skill");

                const data = toGalleryData(result);
                expect(data).toBeDefined();
                expect(data?.type).toBe("skill");
                expect(data?.results.length).toBeGreaterThan(0);
                for (const facet of data?.results ?? []) {
                    expect(facet.counts.some(count => count.type === "skill")).toBe(true);
                }
                // The agent-only facet has no skill asset, so the filter drops it.
                expect(data?.results.some(facet => facet.name === "agent-facet")).toBe(false);
            } finally {
                await harness.close();
            }
        });

        test("UI client gets installed state and nextCursor in summary; payload carries both with parsed rows", async () => {
            const projectRoot = scratch();
            // Mock skill-facet installed at an older version
            const harness = await connect(UI_CAPABLE, projectRoot, makeFetchFacets(true), { "skill-facet": "0.9.5" });
            try {
                const result = await harness.client.callTool({ name: "facet_browse", arguments: { query: "test" } });
                const ui = extractResult(result);

                // The summary carries what the model needs to act — which facets
                // came back, and whether a page follows — and no install state,
                // no descriptions, nothing to write out under the panel.
                expect(ui.structuredContent.kind).toBe("gallery-summary");
                expect(ui.structuredContent.nextCursor).toBe("page2_token");
                expect(ui.structuredContent.names).toEqual(["skill-facet", "agent-facet"]);
                expect(ui.structuredContent.facets).toBeUndefined();
                assertNoDescription(JSON.stringify(ui.structuredContent));
                expect(JSON.stringify(ui.structuredContent)).not.toContain("0.9.5");

                // Payload (in _meta) has the real gallery data
                expect(ui.meta).toBeDefined();
                const payload = (ui.meta?.[PANEL_PAYLOAD_KEY] as { payload?: Record<string, unknown> })?.payload;
                expect(payload).toBeDefined();
                expect(payload?.kind).toBe("gallery");
                expect(payload?.nextCursor).toBe("page2_token");

                const payloadResults = payload?.results as Array<{ name: string; installed?: { version: string; updateAvailable: boolean } }>;
                expect(Array.isArray(payloadResults)).toBe(true);
                const payloadSkillFacet = payloadResults.find(f => f.name === "skill-facet");
                expect(payloadSkillFacet?.installed?.version).toBe("0.9.5");
                expect(payloadSkillFacet?.installed?.updateAvailable).toBe(true);

                // toGalleryData parses the raw result correctly
                const data = toGalleryData(result);
                expect(data).toBeDefined();
                expect(data?.nextCursor).toBe("page2_token");
                expect(data?.results.length).toBeGreaterThan(0);
                const parsedSkillFacet = data?.results.find(f => f.name === "skill-facet");
                expect(parsedSkillFacet?.installed?.version).toBe("0.9.5");
                expect(parsedSkillFacet?.installed?.updateAvailable).toBe(true);
            } finally {
                await harness.close();
            }
        });

        test("text-only client gets full gallery payload in structuredContent, no envelope", async () => {
            const projectRoot = scratch();
            // Mock skill-facet installed at an older version
            const harness = await connect(TEXT_ONLY, projectRoot, makeFetchFacets(true), { "skill-facet": "0.9.5" });
            try {
                const result = await harness.client.callTool({ name: "facet_browse", arguments: { query: "test" } });
                const text = extractResult(result);

                // Text client: full gallery in structuredContent
                expect(text.structuredContent.kind).toBe("gallery");
                expect(text.structuredContent.query).toBe("test");
                expect(text.structuredContent.nextCursor).toBe("page2_token");

                const results = text.structuredContent.results as Array<{ name: string; installed?: { version: string; updateAvailable: boolean } }>;
                expect(Array.isArray(results)).toBe(true);
                const skillFacet = results.find(f => f.name === "skill-facet");
                expect(skillFacet?.installed?.version).toBe("0.9.5");
                expect(skillFacet?.installed?.updateAvailable).toBe(true);

                // No _meta envelope for text-only
                expect(text.meta).toBeUndefined();
            } finally {
                await harness.close();
            }
        });
    });

    describe("facet_contents", () => {
        test("handles no-version case by resolving to latest and returning resolved version", async () => {
            const projectRoot = scratch();
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const result = await harness.client.callTool({ name: "facet_contents", arguments: { name: "test-facet" } });
                const extracted = extractResult(result);

                expect(extracted.structuredContent.kind).toBe("contents");
                expect(extracted.structuredContent.facet).toBe("test-facet");
                // Should resolve to latest version
                expect(extracted.structuredContent.version).toBe("1.0.0");
                expect(Array.isArray(extracted.structuredContent.assets)).toBe(true);
            } finally {
                await harness.close();
            }
        });
    });

    describe("facet_detail", () => {
        test("UI client gets a summary and a payload in _meta; text-only gets the full payload", async () => {
            const projectRoot = scratch();
            const uiHarness = await connect(UI_CAPABLE, projectRoot);
            const textHarness = await connect(TEXT_ONLY, projectRoot);
            try {
                const uiResult = await uiHarness.client.callTool({ name: "facet_detail", arguments: { name: "test-facet" } });
                const textResult = await textHarness.client.callTool({ name: "facet_detail", arguments: { name: "test-facet" } });

                const ui = extractResult(uiResult);
                const text = extractResult(textResult);

                expect(ui.structuredContent.kind).toBe("detail-summary");
                assertNoDescription(JSON.stringify(ui.structuredContent));
                expect(ui.meta).toBeDefined();
                expect(ui.content).toContain("panel");

                expect(text.structuredContent.kind).toBe("detail");
                expect(text.meta).toBeUndefined();
                expect(text.content).toContain("test-facet@1.0.0");
                expect(text.content).toContain("A test facet for the seam.");
            } finally {
                await uiHarness.close();
                await textHarness.close();
            }
        });

        test("the UI reader reconstructs the real detail structure", async () => {
            const projectRoot = scratch();
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const result = await harness.client.callTool({ name: "facet_detail", arguments: { name: "test-facet" } });
                const data = toDetailData(result);
                expect(data).toBeDefined();
                expect(data?.facet).toBe("test-facet");
                expect(data?.version).toBe("1.0.0");
                expect(data?.description).toBe("A test facet for the seam.");
                expect(data?.counts.some(count => count.type === "skill")).toBe(true);
            } finally {
                await harness.close();
            }
        });
    });

    describe("facet_readme", () => {
        test("UI client gets a summary and a payload in _meta; text-only gets the full payload", async () => {
            const projectRoot = scratch();
            const uiHarness = await connect(UI_CAPABLE, projectRoot);
            const textHarness = await connect(TEXT_ONLY, projectRoot);
            try {
                const uiResult = await uiHarness.client.callTool({ name: "facet_readme", arguments: { name: "test-facet", version: "1.0.0" } });
                const textResult = await textHarness.client.callTool({ name: "facet_readme", arguments: { name: "test-facet", version: "1.0.0" } });

                const ui = extractResult(uiResult);
                const text = extractResult(textResult);

                expect(ui.structuredContent.kind).toBe("readme-summary");
                assertNoDescription(JSON.stringify(ui.structuredContent));
                expect(ui.meta).toBeDefined();
                expect(ui.content).toContain("panel");

                expect(text.structuredContent.kind).toBe("readme");
                expect(text.meta).toBeUndefined();
                // Text-only prose is the README itself, verbatim.
                expect(text.content).toBe("# Test Facet\n\nDetails about the test facet.");
            } finally {
                await uiHarness.close();
                await textHarness.close();
            }
        });

        test("the UI reader reconstructs the real readme structure", async () => {
            const projectRoot = scratch();
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const result = await harness.client.callTool({ name: "facet_readme", arguments: { name: "test-facet", version: "1.0.0" } });
                const data = toReadmeData(result);
                expect(data).toBeDefined();
                expect(data?.file).toBe("README.md");
                expect(data?.text).toContain("Test Facet");
                expect(data?.truncated).toBe(false);
            } finally {
                await harness.close();
            }
        });
    });

    describe("facet_project", () => {
        test("UI client gets a summary and a payload in _meta; text-only gets the full payload", async () => {
            const projectRoot = scratch();
            writeProjectFixtures(projectRoot);
            const uiHarness = await connect(UI_CAPABLE, projectRoot);
            const textHarness = await connect(TEXT_ONLY, projectRoot);
            try {
                const uiResult = await uiHarness.client.callTool({ name: "facet_project", arguments: {} });
                const textResult = await textHarness.client.callTool({ name: "facet_project", arguments: {} });

                const ui = extractResult(uiResult);
                const text = extractResult(textResult);

                expect(ui.structuredContent.kind).toBe("installed-summary");
                assertNoDescription(JSON.stringify(ui.structuredContent));
                expect(ui.meta).toBeDefined();
                expect(ui.content).toContain("panel");

                expect(text.structuredContent.kind).toBe("installed");
                expect(text.meta).toBeUndefined();
                expect(text.content).toContain("demo-facet");
            } finally {
                await uiHarness.close();
                await textHarness.close();
            }
        });

        test("the UI reader reconstructs the real installed structure", async () => {
            const projectRoot = scratch();
            writeProjectFixtures(projectRoot);
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const result = await harness.client.callTool({ name: "facet_project", arguments: {} });
                const data = toInstalledData(result);
                expect(data).toBeDefined();
                expect(data?.directory).toBe(projectRoot);
                expect(data?.declared).toBe(true);
                expect(data?.facets.some(facet => facet.name === "demo-facet")).toBe(true);
            } finally {
                await harness.close();
            }
        });
    });

    describe("facet_manifest", () => {
        test("UI client gets a summary and a payload in _meta; text-only gets the full payload", async () => {
            const projectRoot = scratch();
            writeProjectFixtures(projectRoot);
            const uiHarness = await connect(UI_CAPABLE, projectRoot);
            const textHarness = await connect(TEXT_ONLY, projectRoot);
            try {
                const uiResult = await uiHarness.client.callTool({ name: "facet_manifest", arguments: {} });
                const textResult = await textHarness.client.callTool({ name: "facet_manifest", arguments: {} });

                const ui = extractResult(uiResult);
                const text = extractResult(textResult);

                expect(ui.structuredContent.kind).toBe("author-summary");
                assertNoDescription(JSON.stringify(ui.structuredContent));
                expect(ui.meta).toBeDefined();
                expect(ui.content).toContain("panel");

                expect(text.structuredContent.kind).toBe("author");
                expect(text.meta).toBeUndefined();
                expect(text.content).toContain("demo-facet");
                expect(text.content).toContain("A demo facet used by the seam test.");
            } finally {
                await uiHarness.close();
                await textHarness.close();
            }
        });

        test("the UI reader reconstructs the real author structure", async () => {
            const projectRoot = scratch();
            writeProjectFixtures(projectRoot);
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const result = await harness.client.callTool({ name: "facet_manifest", arguments: {} });
                const data = toAuthorData(result);
                expect(data).toBeDefined();
                expect(data?.name).toBe("demo-facet");
                expect(data?.version).toBe("1.2.0");
                expect(data?.present).toBe(true);
            } finally {
                await harness.close();
            }
        });
    });

    describe("adversarial", () => {
        test("every reader refuses a UI result once its _meta payload is gone", async () => {
            const projectRoot = scratch();
            const harness = await connect(UI_CAPABLE, projectRoot);
            try {
                const original = await harness.client.callTool({ name: "facet_browse", arguments: { query: "test" } });
                const stripped = structuredClone(original) as typeof original;
                delete (stripped as { _meta?: unknown })._meta;

                // structuredContent still says "gallery-summary" — a real kind's
                // reader must not be fooled into treating a summary as a payload.
                expect(toGalleryData(stripped)).toBeUndefined();
                expect(toDetailData(stripped)).toBeUndefined();
                expect(toReadmeData(stripped)).toBeUndefined();
                expect(toInstalledData(stripped)).toBeUndefined();
                expect(toAuthorData(stripped)).toBeUndefined();
            } finally {
                await harness.close();
            }
        });
    });
});
