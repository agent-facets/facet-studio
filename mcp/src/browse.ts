// Browsing the registry.
//
// Every other tool here shells out to the `facet` CLI, but browsing can't: the
// CLI's `search` has no JSON mode and its human output drops the description
// entirely, so a gallery built on it would be a list of names. The registry API
// already returns everything the panel wants, and all of it is anonymous, so
// this one tool talks to the API directly. Tracked upstream as
// `search-view-drops-description`; when the CLI grows `--json` this can move
// back onto the shared argv machinery.

import { z } from "zod";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { DEFAULT_REGISTRY_URL, REQUEST_TIMEOUT_MS } from "./auth.js";
import { PANEL_RESOURCE_URI } from "./view/panel.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegistrationDeps } from "./server.js";

/** Most results one call will return, and the ceiling a caller can ask for. */
export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 24;

/** What the registry returns per facet. Unknown fields are ignored. */
const FacetSummary = z.object({
    name: z.string(),
    latest_version: z.string().optional(),
    published_at: z.string().optional(),
    description: z.string().optional(),
    publisher: z.string().optional(),
    owner: z.object({ username: z.string().optional() }).partial().optional(),
    asset_counts: z.record(z.string(), z.number()).optional(),
    visibility: z.string().optional(),
});

const SearchResponse = z.object({ facets: z.array(FacetSummary).default([]) });

/** The asset-count keys the registry uses, mapped to the panel's singular names. */
const COUNT_KEYS: Record<string, string> = {
    skills: "skill",
    agents: "agent",
    commands: "command",
    servers: "server",
};

/** How the registry labels each type, singular and plural. */
const COUNT_LABELS: Record<string, { one: string; many: string }> = {
    skill: { one: "Skill", many: "Skills" },
    agent: { one: "Agent", many: "Agents" },
    command: { one: "Command", many: "Commands" },
    server: { one: "MCP", many: "MCP" },
};

/** One asset-count chip: which type, and the text to print on it. */
export interface GalleryCount {
    type: string;
    label: string;
}

/** One facet as the gallery draws it. */
export interface GalleryFacet {
    name: string;
    version: string;
    description: string;
    publisher: string;
    published: string;
    counts: GalleryCount[];
}

/** The structured payload the panel renders as a gallery. */
export interface GalleryData {
    kind: "gallery";
    query: string;
    results: GalleryFacet[];
}

/** The one network call this module makes. Tests replace it. */
export type FetchFacets = (url: string) => Promise<unknown>;

export interface BrowseDeps extends Partial<RegistrationDeps> {
    /** Registry base URL. Defaults to `FACET_REGISTRY_URL`, then the public one. */
    registryUrl?: string;
    fetchFacets?: FetchFacets;
    env?: Record<string, string | undefined>;
}

function stripTrailingSlashes(value: string): string {
    return value.replace(/\/+$/, "");
}

/** ISO timestamp to the short form the registry shows, e.g. `Jul 29`. */
export function shortDate(iso: string | undefined): string {
    if (iso === undefined) {
        return "";
    }
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) {
        return "";
    }
    return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Turns `asset_counts` into chip text, dropping the zeroes. */
export function toCounts(counts: Record<string, number> | undefined): GalleryCount[] {
    if (counts === undefined) {
        return [];
    }
    const out: GalleryCount[] = [];
    for (const [plural, type] of Object.entries(COUNT_KEYS)) {
        const n = counts[plural];
        if (typeof n !== "number" || n <= 0) {
            continue;
        }
        const label = COUNT_LABELS[type] ?? { one: type, many: `${type}s` };
        out.push({ type, label: `${n} ${n === 1 ? label.one : label.many}` });
    }
    return out;
}

/** Normalizes one registry summary into what the panel draws. */
export function toGalleryFacet(summary: z.infer<typeof FacetSummary>): GalleryFacet {
    return {
        name: summary.name,
        version: summary.latest_version ?? "",
        description: summary.description ?? "No description",
        publisher: summary.publisher ?? summary.owner?.username ?? "",
        published: shortDate(summary.published_at),
        counts: toCounts(summary.asset_counts),
    };
}

/** The plain-text half of the result, for hosts that render no UI at all. */
export function toText(data: GalleryData): string {
    if (data.results.length === 0) {
        return data.query === ""
            ? "The registry returned no facets."
            : `No facets matched ${data.query}.`;
    }
    const lines = data.results.map(facet => {
        const version = facet.version === "" ? "" : `@${facet.version}`;
        const counts = facet.counts.map(count => count.label).join(", ");
        const by = facet.publisher === "" ? "" : ` · by ${facet.publisher}`;
        const parts = [`${facet.name}${version}${by}`, facet.description];
        return counts === "" ? `- ${parts.join(" — ")}` : `- ${parts.join(" — ")} (${counts})`;
    });
    const heading = data.query === ""
        ? `${data.results.length} facet${data.results.length === 1 ? "" : "s"} on the registry:`
        : `${data.results.length} facet${data.results.length === 1 ? "" : "s"} matching ${data.query}:`;
    return [heading, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// What is inside a facet
// ---------------------------------------------------------------------------

/** One asset inside a facet, as the expanded card lists it. */
export interface ContentAsset {
    type: string;
    name: string;
    detail: string;
}

/** The structured payload the panel folds into an expanded card. */
export interface ContentsData {
    kind: "contents";
    facet: string;
    version: string;
    assets: ContentAsset[];
}

const VersionMetadata = z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    /** The facet's own manifest, verbatim, as a JSON string. */
    manifest_json: z.string().optional(),
});

/** The manifest sections that hold assets, in the order a card lists them. */
const MANIFEST_SECTIONS: readonly (readonly [string, string])[] = [
    ["skills", "skill"],
    ["agents", "agent"],
    ["commands", "command"],
    ["servers", "server"],
];

/**
 * Pulls the asset list out of a facet's manifest.
 *
 * The manifest arrives as a JSON string, and it is published content rather than
 * anything this server controls, so a malformed one yields an empty list instead
 * of throwing — an expanded card with nothing in it beats a broken panel.
 */
export function parseManifestAssets(manifestJson: string | undefined): ContentAsset[] {
    if (manifestJson === undefined) {
        return [];
    }
    let manifest: unknown;
    try {
        manifest = JSON.parse(manifestJson);
    } catch {
        return [];
    }
    if (typeof manifest !== "object" || manifest === null) {
        return [];
    }
    const record = manifest as Record<string, unknown>;
    const assets: ContentAsset[] = [];
    for (const [section, type] of MANIFEST_SECTIONS) {
        const entries = record[section];
        if (typeof entries !== "object" || entries === null) {
            continue;
        }
        for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
            const detail =
                typeof value === "object" && value !== null && typeof (value as { description?: unknown }).description === "string"
                    ? ((value as { description: string }).description)
                    : "";
            assets.push({ type, name, detail });
        }
    }
    return assets;
}

const contentsShape = {
    name: z.string().trim().min(1).max(200).describe("Facet name, e.g. `graphite` or `@scope/name`."),
    version: z.string().trim().min(1).max(64).describe("Which version to read."),
};

const contentsSchema = z.object(contentsShape);

/** Reads one published version and lists what is inside it. */
export async function contents(args: { name: string; version: string }, deps: BrowseDeps = {}): Promise<ContentsData> {
    const env = deps.env ?? process.env;
    const base = stripTrailingSlashes(deps.registryUrl ?? env.FACET_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
    const path = `${encodeURIComponent(args.name)}/${encodeURIComponent(args.version)}`;
    // A scoped name carries a slash that must stay a path separator, not %2F.
    const url = `${base}/v0/facets/${path.replace(/%40/g, "@").replace(/%2F/g, "/")}`;

    const fetchFacets = deps.fetchFacets ?? defaultFetch;
    const parsed = VersionMetadata.parse(await fetchFacets(url));

    return {
        kind: "contents",
        facet: parsed.name ?? args.name,
        version: parsed.version ?? args.version,
        assets: parseManifestAssets(parsed.manifest_json),
    };
}

/** The plain-text half of a contents result. */
export function contentsToText(data: ContentsData): string {
    if (data.assets.length === 0) {
        return `${data.facet}@${data.version} lists no assets.`;
    }
    const lines = data.assets.map(asset =>
        asset.detail === "" ? `- ${asset.name} (${asset.type})` : `- ${asset.name} (${asset.type}) — ${asset.detail}`,
    );
    return [`Inside ${data.facet}@${data.version}:`, ...lines].join("\n");
}

const browseShape = {
    query: z.string().trim().max(200).optional().describe("Search term. Omit to list what is on the registry."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most results to return (default ${DEFAULT_LIMIT}).`),
};

const browseSchema = z.object(browseShape);

/** Fetches and normalizes a page of registry results. */
export async function browse(args: { query?: string; limit?: number }, deps: BrowseDeps = {}): Promise<GalleryData> {
    const env = deps.env ?? process.env;
    const base = stripTrailingSlashes(deps.registryUrl ?? env.FACET_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
    const query = args.query?.trim() ?? "";
    const limit = args.limit ?? DEFAULT_LIMIT;

    const url = new URL(`${base}/v0/facets`);
    if (query !== "") {
        url.searchParams.set("q", query);
    }
    url.searchParams.set("sort", query === "" ? "recent" : "relevance");

    const fetchFacets = deps.fetchFacets ?? defaultFetch;
    const parsed = SearchResponse.parse(await fetchFacets(url.toString()));

    return {
        kind: "gallery",
        query,
        results: parsed.facets.slice(0, limit).map(toGalleryFacet),
    };
}

async function defaultFetch(url: string): Promise<unknown> {
    const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`The registry answered ${response.status} ${response.statusText}.`);
    }
    return await response.json();
}

/**
 * Registers `facet_browse`.
 *
 * Read-only and open-world: it reaches the network and changes nothing, which is
 * what lets a host offer it without a confirmation prompt.
 */
export function registerBrowse(server: Pick<McpServer, "registerTool">, deps: BrowseDeps = {}): void {
    const config = {
        title: "Browse facets",
        description:
            "Search the Agent Facets registry and show the matching facets — what each one does, " +
            "who published it, and what is inside it. Use this whenever someone asks what facets " +
            "exist, what is available, or wants to find a facet to install.",
        inputSchema: browseShape,
        annotations: {
            title: "Browse facets",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        const args = browseSchema.parse(rawArgs ?? {});
        try {
            const data = await browse(args, deps);
            return {
                content: [{ type: "text", text: toText(data) }],
                structuredContent: data as unknown as Record<string, unknown>,
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: "text", text: `Could not reach the registry. ${reason}` }],
            };
        }
    };

    if (deps.supportsUi === true) {
        registerAppTool(
            server,
            "facet_browse",
            { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } },
            handler as never,
        );
    } else {
        server.registerTool("facet_browse", config, handler as never);
    }

    registerContents(server, deps);
}

/**
 * Registers `facet_contents`.
 *
 * The panel calls this itself when someone expands a card, so it carries no UI
 * metadata of its own — its result is folded into the gallery that is already on
 * screen rather than replacing it.
 */
function registerContents(server: Pick<McpServer, "registerTool">, deps: BrowseDeps): void {
    const config = {
        title: "What is inside a facet",
        description:
            "List the skills, agents, commands and MCP servers inside one published facet version. " +
            "Use this to show someone what they would actually be installing.",
        inputSchema: contentsShape,
        annotations: {
            title: "What is inside a facet",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        const args = contentsSchema.parse(rawArgs ?? {});
        try {
            const data = await contents(args, deps);
            return {
                content: [{ type: "text", text: contentsToText(data) }],
                structuredContent: data as unknown as Record<string, unknown>,
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: "text", text: `Could not read ${args.name}@${args.version}. ${reason}` }],
            };
        }
    };

    server.registerTool("facet_contents", config, handler as never);
}
