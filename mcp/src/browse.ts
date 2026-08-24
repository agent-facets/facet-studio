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
import { panelEnvelope, readout } from "./surface.js";
import { PANEL_RESOURCE_URI } from "./view/panel.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegistrationDeps } from "./server.js";
import { readProject, type InstalledFacet } from "./project.js";

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

const SearchResponse = z.object({
    facets: z.array(FacetSummary).default([]),
    next_cursor: z.string().optional(),
});

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
    /** This project's own copy, when it has one. Absent — never null — when it doesn't. */
    installed?: { version: string; updateAvailable: boolean };
}

/** The structured payload the panel renders as a gallery. */
export interface GalleryData {
    kind: "gallery";
    query: string;
    /** True when the query matched nothing and everything published is shown instead. */
    fallback?: boolean;
    /** Asset type to filter by, if set. One of skill, agent, command, or server. */
    type?: string;
    /** Opaque page token for fetching the next page of results. Omitted when no further page exists. */
    nextCursor?: string;
    results: GalleryFacet[];
}

/** The one network call this module makes. Tests replace it. */
export type FetchFacets = (url: string) => Promise<unknown>;

export interface BrowseDeps extends Partial<RegistrationDeps> {
    /** Registry base URL. Defaults to `FACET_REGISTRY_URL`, then the public one. */
    registryUrl?: string;
    fetchFacets?: FetchFacets;
    env?: Record<string, string | undefined>;
    /** Reads this project's installed facets. Defaults to the real `readProject`; tests replace it. */
    readProjectFn?: typeof readProject;
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
    const count = `${data.results.length} facet${data.results.length === 1 ? "" : "s"}`;
    const typeClause = data.type !== undefined ? ` carrying ${data.type} assets` : "";
    const heading =
        data.query === ""
            ? `${count}${typeClause} on the registry:`
            : data.fallback === true
              ? `Nothing matched ${data.query}, so here is everything published${typeClause} — ${count}:`
              : `${count}${typeClause} matching ${data.query}:`;
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
    description: z.string().optional(),
    published_at: z.string().optional(),
    publisher: z.string().optional(),
    owner: z.object({ username: z.string().optional() }).partial().optional(),
    asset_counts: z.record(z.string(), z.number()).optional(),
    visibility: z.string().optional(),
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
    version: z.string().trim().min(1).max(64).optional().describe("Which version to read. Defaults to the latest release."),
};

const contentsSchema = z.object(contentsShape);

/**
 * A facet name as a URL path.
 *
 * Two characters need care. The `@` of a scope stays literal, because the
 * registry's routes match a literal `@` and a `%40` is only tolerated, never
 * emitted on purpose. The `/` between scope and name stays a real separator,
 * so each half is encoded on its own rather than the whole string at once.
 */
export function facetPath(name: string): string {
    const slash = name.startsWith("@") ? name.indexOf("/") : -1;
    if (slash === -1) {
        return encodeURIComponent(name);
    }
    return `@${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
}

/** The registry's base URL for this call: the caller's, the env's, or the public one. */
function baseUrl(deps: BrowseDeps): string {
    const env = deps.env ?? process.env;
    return stripTrailingSlashes(deps.registryUrl ?? env.FACET_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
}

/** Reads one published version and lists what is inside it. */
export async function contents(args: { name: string; version?: string }, deps: BrowseDeps = {}): Promise<ContentsData> {
    const base = baseUrl(deps);
    const fetchFacets = deps.fetchFacets ?? defaultFetch;
    const version = args.version ?? (await latestVersionOf(base, args.name, fetchFacets));
    const url = `${base}/v0/facets/${facetPath(args.name)}/${encodeURIComponent(version)}`;

    const parsed = VersionMetadata.parse(await fetchFacets(url));

    return {
        kind: "contents",
        facet: parsed.name ?? args.name,
        version: parsed.version ?? version,
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

// ---------------------------------------------------------------------------
// One facet, at length
// ---------------------------------------------------------------------------

/** The structured payload the panel renders as the Detail screen. */
export interface DetailData {
    kind: "detail";
    facet: string;
    version: string;
    description: string;
    publisher: string;
    published: string;
    visibility: string;
    counts: GalleryCount[];
    assets: ContentAsset[];
    /** Every published version, newest first. */
    versions: string[];
}

const LatestVersion = z.object({ name: z.string().optional(), latest: z.string() });
const VersionList = z.object({ versions: z.array(z.string()).default([]) });

/** Which version to open the screen on, when the caller didn't say. */
async function latestVersionOf(base: string, name: string, fetchFacets: FetchFacets): Promise<string> {
    const parsed = LatestVersion.parse(await fetchFacets(`${base}/v0/facets/${facetPath(name)}/latest-version`));
    return parsed.latest;
}

/**
 * Everything one facet's detail screen shows, in as few round trips as it takes.
 *
 * The version list is fetched alongside the metadata rather than after it,
 * because the two are independent and the screen wants both. A failing version
 * list is not a failing screen: the list comes back empty and the Versions tab
 * says so, which is better than losing the description and the asset list over
 * it.
 */
export async function detail(args: { name: string; version?: string }, deps: BrowseDeps = {}): Promise<DetailData> {
    const base = baseUrl(deps);
    const fetchFacets = deps.fetchFacets ?? defaultFetch;
    const version = args.version ?? (await latestVersionOf(base, args.name, fetchFacets));
    const at = `${base}/v0/facets/${facetPath(args.name)}`;

    const [metadata, versions] = await Promise.all([
        fetchFacets(`${at}/${encodeURIComponent(version)}`).then(value => VersionMetadata.parse(value)),
        fetchFacets(`${at}/versions/${encodeURIComponent(version)}`)
            .then(value => VersionList.parse(value).versions)
            .catch(() => [] as string[]),
    ]);

    return {
        kind: "detail",
        facet: metadata.name ?? args.name,
        version: metadata.version ?? version,
        description: metadata.description ?? "",
        publisher: metadata.publisher ?? metadata.owner?.username ?? "",
        published: shortDate(metadata.published_at),
        visibility: metadata.visibility ?? "",
        counts: toCounts(metadata.asset_counts),
        assets: parseManifestAssets(metadata.manifest_json),
        // The registry sorts ascending; a version history reads newest first.
        versions: [...versions].reverse(),
    };
}

/** The plain-text half of a detail result. */
export function detailToText(data: DetailData): string {
    const head = `${data.facet}@${data.version}${data.publisher === "" ? "" : ` · by ${data.publisher}`}`;
    const counts = data.counts.map(count => count.label).join(", ");
    const lines = data.assets.map(asset =>
        asset.detail === "" ? `- ${asset.name} (${asset.type})` : `- ${asset.name} (${asset.type}) — ${asset.detail}`,
    );
    const versions =
        data.versions.length === 0 ? [] : [`Versions: ${data.versions.slice(0, 10).join(", ")}`];
    return [head, data.description, counts, ...lines, ...versions].filter(line => line !== "").join("\n");
}

// ---------------------------------------------------------------------------
// The README
// ---------------------------------------------------------------------------

/** The structured payload behind the README tab. */
export interface ReadmeData {
    kind: "readme";
    facet: string;
    version: string;
    /** The file the text came from, e.g. `README.md`. Empty when there is none. */
    file: string;
    text: string;
    /** True when the text was cut at {@link README_LIMIT}. */
    truncated: boolean;
}

/** How much README the panel will show. Longer files are cut, not refused. */
export const README_LIMIT = 24_000;

/** A root-level README, by the same rule the registry's own detail page uses. */
const ROOT_README = /^readme(\.[^.]+)?$/i;

const ContentsFile = z.object({
    kind: z.string().optional(),
    path: z.string(),
    content: z.string().optional(),
});

const ContentsResponse = z.object({ files: z.array(ContentsFile).default([]) });

/**
 * Fetches one version's README.
 *
 * This is the panel's own call, made when someone opens the tab, because the
 * contents endpoint returns every text file in the facet and there is no reason
 * to pay for that while drawing a card.
 */
export async function readme(args: { name: string; version?: string }, deps: BrowseDeps = {}): Promise<ReadmeData> {
    const base = baseUrl(deps);
    const fetchFacets = deps.fetchFacets ?? defaultFetch;
    const version = args.version ?? (await latestVersionOf(base, args.name, fetchFacets));
    const url = `${base}/v0/facets/${facetPath(args.name)}/${encodeURIComponent(version)}/contents`;
    const parsed = ContentsResponse.parse(await fetchFacets(url));

    const found = parsed.files.find(file => file.kind === "text" && ROOT_README.test(file.path));
    const text = found?.content ?? "";
    return {
        kind: "readme",
        facet: args.name,
        version: version,
        file: found?.path ?? "",
        text: text.slice(0, README_LIMIT),
        truncated: text.length > README_LIMIT,
    };
}

const browseShape = {
    query: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe(
            "One short literal term the user actually said, e.g. \"git\". Multi-word phrases match nothing. Omit for anything thematic — the full catalog is one page.",
        ),
    // No upper bound in the schema: a host model that asks for 50 should get
    // the capped page, not a validation error it can do nothing about.
    limit: z.number().int().min(1).optional().describe(`Most results to return (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`),
    type: z
        .enum(["skill", "agent", "command", "server"])
        .optional()
        .describe(
            "Only facets carrying at least one asset of this type. Set it whenever the user names a kind — skills, agents, commands, MCP servers.",
        ),
    cursor: z
        .string()
        .trim()
        .min(1)
        .max(600)
        .optional()
        .describe("Opaque page token from a previous result's nextCursor. Only valid with the same query and type."),
};

const browseSchema = z.object(browseShape);

/**
 * This project's installed facets, keyed by their full registry name.
 *
 * `undefined` means "say nothing about install state" — either the project
 * couldn't be read, or it has no `facets.json` at all. A scratch directory
 * must never claim install state, so both cases fall back the same way: the
 * registry rows come back unjoined rather than guessing.
 */
async function loadInstalled(deps: BrowseDeps): Promise<Map<string, InstalledFacet> | undefined> {
    const readProjectFn = deps.readProjectFn ?? readProject;
    try {
        const data = await readProjectFn(undefined, deps);
        if (!data.declared) {
            return undefined;
        }
        return new Map(data.facets.map(facet => [facet.name, facet]));
    } catch {
        return undefined;
    }
}

/**
 * Adds this project's install state to one row, when it has any to add.
 *
 * The match is on the full `@scope/name` — a scoped and an unscoped facet
 * that happen to share a short name are different facets, and stripping the
 * scope before matching would join them by mistake. A facet the project has
 * declared but never installed gets no key either: the gallery's own Install
 * button is already the right affordance for that, and an install-shaped key
 * with nothing in it would just be confusing.
 */
function withInstalled(facet: GalleryFacet, installed: Map<string, InstalledFacet> | undefined): GalleryFacet {
    const entry = installed?.get(facet.name);
    if (entry === undefined || !entry.installed) {
        return facet;
    }
    return {
        ...facet,
        installed: {
            version: entry.version,
            updateAvailable: entry.version !== "" && facet.version !== entry.version,
        },
    };
}

/** Fetches and normalizes a page of registry results. */
export async function browse(args: { query?: string; limit?: number; type?: string; cursor?: string }, deps: BrowseDeps = {}): Promise<GalleryData> {
    const env = deps.env ?? process.env;
    const base = stripTrailingSlashes(deps.registryUrl ?? env.FACET_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
    const query = args.query?.trim() ?? "";
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const url = new URL(`${base}/v0/facets`);
    if (query !== "") {
        url.searchParams.set("q", query);
    }
    url.searchParams.set("sort", query === "" ? "recent" : "relevance");
    if (args.cursor !== undefined) {
        url.searchParams.set("cursor", args.cursor);
    }

    const fetchFacets = deps.fetchFacets ?? defaultFetch;
    let parsed = SearchResponse.parse(await fetchFacets(url.toString()));

    // The registry's search is literal, and a phrase like "dev workflow
    // management" matches nothing even when half the catalog is about exactly
    // that. An empty answer here just makes the caller ask again without the
    // query — a second call, a second widget — so the fallback happens in this
    // one call instead: everything published, marked as such, with the query
    // kept so the screen can say what didn't match.
    let fallback = false;
    if (query !== "" && parsed.facets.length === 0) {
        const everything = new URL(`${base}/v0/facets`);
        everything.searchParams.set("sort", "recent");
        parsed = SearchResponse.parse(await fetchFacets(everything.toString()));
        fallback = true;
    }

    // Resolved once per call, before mapping any row — a broken or absent
    // project degrades to registry-only results rather than half-joining them.
    const installed = await loadInstalled(deps);

    // Map to GalleryFacet first, then apply type filter if set
    let results = parsed.facets.map(toGalleryFacet).map(facet => withInstalled(facet, installed));
    if (args.type !== undefined) {
        results = results.filter(facet => facet.counts.some(count => count.type === args.type));
    }

    return {
        kind: "gallery",
        query,
        fallback,
        type: args.type,
        ...(parsed.next_cursor !== undefined ? { nextCursor: parsed.next_cursor } : {}),
        results: results.slice(0, limit),
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
            "exist, what is available, or wants to find a facet to install. Call it AT MOST ONCE " +
            "per question — every call renders its own panel, and the user can refine the search " +
            "inside it. The registry search is literal, so translate intent into criteria: put only a real " +
            "keyword in `query` (\"git\", not \"git related facets\"), set `type` when the user " +
            "names an asset kind (\"git skills\" → query git, type skill; \"MCP servers\" → type " +
            "server), and omit `query` for anything thematic — the catalog is small — then judge " +
            "relevance from the one result. Never issue several browses with different phrasings.",
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
            const count = data.results.length === 1 ? "1 facet" : `${data.results.length} facets`;
            const typeInfo = data.type !== undefined ? ` (type: ${data.type})` : "";
            const brief =
                data.query === ""
                    ? `${count}${typeInfo} from the registry, in the panel's Registry screen.`
                    : data.fallback === true
                      ? `Nothing matched "${data.query}" exactly, so the panel's Registry screen is showing everything published — ${count}${typeInfo}. Do not browse again.`
                      : `${count}${typeInfo} matching "${data.query}", in the panel's Registry screen.`;
            const summary = {
                kind: "gallery-summary",
                query: data.query,
                ...(data.type === undefined ? {} : { type: data.type }),
                ...(data.fallback === undefined ? {} : { fallback: data.fallback }),
                ...(data.nextCursor === undefined ? {} : { nextCursor: data.nextCursor }),
                total: data.results.length,
                names: data.results.map(facet => facet.name),
            };
            return panelEnvelope(deps.supportsUi, {
                text: readout(deps.supportsUi, brief, () => toText(data)),
                payload: data as unknown as Record<string, unknown>,
                summary,
            });
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
    registerDetail(server, deps);
    registerReadme(server, deps);
}

const detailShape = {
    name: z.string().trim().min(1).max(200).describe("Facet name, e.g. `graphite` or `@scope/name`."),
    version: z.string().trim().min(1).max(64).optional().describe("Which version to open. Defaults to the latest."),
};

const detailSchema = z.object(detailShape);

/**
 * Registers `facet_detail`.
 *
 * The single-facet answer: what it does, who published it, what is inside it,
 * and every version it has had. This is what a question about one named facet
 * should reach for, rather than a search that happens to return it.
 */
function registerDetail(server: Pick<McpServer, "registerTool">, deps: BrowseDeps): void {
    const config = {
        title: "Facet detail",
        description:
            "Show everything about one published facet: its description, publisher, assets, and version history. " +
            "Use this when someone asks about a facet by name rather than searching for one.",
        inputSchema: detailShape,
        annotations: {
            title: "Facet detail",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        const args = detailSchema.parse(rawArgs ?? {});
        try {
            const data = await detail(args, deps);
            const brief = `${data.facet}@${data.version} is open in the panel: description, assets, and version history.`;
            const summary = {
                kind: "detail-summary",
                facet: data.facet,
                version: data.version,
                versions: data.versions.length,
            };
            return panelEnvelope(deps.supportsUi, {
                text: readout(deps.supportsUi, brief, () => detailToText(data)),
                payload: data as unknown as Record<string, unknown>,
                summary,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: "text", text: `Could not read ${args.name}. ${reason}` }],
            };
        }
    };

    if (deps.supportsUi === true) {
        registerAppTool(
            server,
            "facet_detail",
            { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } },
            handler as never,
        );
        return;
    }
    server.registerTool("facet_detail", config, handler as never);
}

const readmeShape = {
    name: z.string().trim().min(1).max(200).describe("Facet name, e.g. `graphite` or `@scope/name`."),
    version: z.string().trim().min(1).max(64).optional().describe("Which version to read. Defaults to the latest release."),
};

const readmeSchema = z.object(readmeShape);

/**
 * Registers `facet_readme`.
 *
 * Like `facet_contents`, this is the panel calling on its own behalf — someone
 * opened the README tab — so it carries no UI metadata and folds into the screen
 * already showing.
 */
function registerReadme(server: Pick<McpServer, "registerTool">, deps: BrowseDeps): void {
    const config = {
        title: "Facet README",
        description: "Read the README a published facet version ships, when it ships one.",
        inputSchema: readmeShape,
        annotations: {
            title: "Facet README",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        const args = readmeSchema.parse(rawArgs ?? {});
        try {
            const data = await readme(args, deps);
            const text =
                data.file === ""
                    ? `${args.name}@${args.version} ships no README.`
                    : readout(
                          deps.supportsUi,
                          `The README for ${args.name}@${args.version} is open in the panel.`,
                          () => data.text,
                      );
            const summary = {
                kind: "readme-summary",
                facet: data.facet,
                version: data.version,
                file: data.file,
                truncated: data.truncated,
            };
            return panelEnvelope(deps.supportsUi, {
                text,
                payload: data as unknown as Record<string, unknown>,
                summary,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: "text", text: `Could not read the README for ${args.name}@${args.version}. ${reason}` }],
            };
        }
    };

    server.registerTool("facet_readme", config, handler as never);
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
