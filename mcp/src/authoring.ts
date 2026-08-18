// The facet you are writing.
//
// The console's Authoring screen shows one facet's own `facet.json` — its name,
// version, visibility, description, and the assets it declares — so an author
// can see the manifest they are about to build and publish. Like ./project.ts
// this reads the file rather than shelling out, because `facet modify --json`
// reports what changed rather than what the manifest now says, and the screen
// needs the latter.
//
// Read-only, again. Every edit the screen offers goes out through `facet_modify`
// and comes back as a fresh read, so the CLI stays the only thing that writes.

import { z } from "zod";
import path from "node:path";
import { readFile, stat, readdir } from "node:fs/promises";
import { resolveDirectory } from "./tools.js";
import { PANEL_RESOURCE_URI } from "./view/panel.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegistrationDeps } from "./server.js";

export const FACET_JSON = "facet.json";

/** An asset entry: the description is what the console lists beside the name. */
const AssetEntry = z.object({ description: z.string().optional() }).loose();

const FacetManifest = z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    private: z.boolean().optional(),
    skills: z.record(z.string(), AssetEntry).optional(),
    agents: z.record(z.string(), AssetEntry).optional(),
    commands: z.record(z.string(), AssetEntry).optional(),
    servers: z.record(z.string(), AssetEntry).optional(),
}).loose();

/** The manifest sections that hold assets, in the order the console lists them. */
const SECTIONS: readonly (readonly [keyof z.infer<typeof FacetManifest>, string])[] = [
    ["skills", "skill"],
    ["agents", "agent"],
    ["commands", "command"],
    ["servers", "server"],
];

/** One asset the manifest declares. */
export interface AuthorAsset {
    type: string;
    name: string;
    detail: string;
}

/** A built archive sitting in dist/, if there is one. */
export interface BuiltArchive {
    file: string;
    /** The archive's size, already worded — "18 KB". */
    size: string;
}

/** The structured payload the panel renders as the Authoring screen. */
export interface AuthorData {
    kind: "author";
    /** False when this directory holds no facet.json — nothing to author here. */
    present: boolean;
    directory: string;
    name: string;
    version: string;
    description: string;
    /** `public` or `private`, in the words the registry uses. */
    visibility: string;
    assets: AuthorAsset[];
    /** What is in dist/ right now, newest first. Empty until something is built. */
    built: BuiltArchive[];
    /** Set when the manifest is unreadable, and shown instead of the fields. */
    problem?: string;
}

function describeSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pulls the assets out of a parsed manifest, section by section. */
export function toAssets(manifest: z.infer<typeof FacetManifest>): AuthorAsset[] {
    const assets: AuthorAsset[] = [];
    for (const [section, type] of SECTIONS) {
        const entries = manifest[section];
        if (typeof entries !== "object" || entries === null) {
            continue;
        }
        for (const [name, value] of Object.entries(entries as Record<string, { description?: string }>)) {
            assets.push({ type, name, detail: value?.description ?? "" });
        }
    }
    return assets;
}

/** What `dist/` holds, newest first. A missing directory is simply nothing. */
async function readBuilt(dir: string): Promise<BuiltArchive[]> {
    const dist = path.join(dir, "dist");
    let names: string[];
    try {
        names = await readdir(dist);
    } catch {
        return [];
    }
    const archives: (BuiltArchive & { at: number })[] = [];
    for (const name of names) {
        if (!name.endsWith(".facet")) {
            continue;
        }
        try {
            const info = await stat(path.join(dist, name));
            archives.push({ file: name, size: describeSize(info.size), at: info.mtimeMs });
        } catch {
            // A file that vanished between listing and stat is simply not there.
        }
    }
    return archives
        .sort((a, b) => b.at - a.at)
        .map(({ file, size }) => ({ file, size }));
}

export interface AuthorDeps {
    /** The root every path is resolved under. Defaults to the process's cwd. */
    projectRoot?: string;
}

/** Reads one facet's manifest and whatever has been built from it. */
export async function readManifest(directory: string | undefined, deps: AuthorDeps = {}): Promise<AuthorData> {
    const root = path.resolve(deps.projectRoot ?? process.cwd());
    const resolved = resolveDirectory(root, directory);
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    const dir = resolved.path;
    const empty: AuthorData = {
        kind: "author",
        present: false,
        directory: dir,
        name: path.basename(dir),
        version: "",
        description: "",
        visibility: "",
        assets: [],
        built: [],
    };

    let text: string;
    try {
        text = await readFile(path.join(dir, FACET_JSON), "utf8");
    } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
            return empty;
        }
        return { ...empty, present: true, problem: `${FACET_JSON} could not be read: ${(error as Error).message}` };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { ...empty, present: true, problem: `${FACET_JSON} is not valid JSON: ${(error as Error).message}` };
    }

    const parsed = FacetManifest.safeParse(raw);
    if (!parsed.success) {
        return { ...empty, present: true, problem: `${FACET_JSON} does not match the shape facet writes.` };
    }

    return {
        kind: "author",
        present: true,
        directory: dir,
        name: parsed.data.name ?? path.basename(dir),
        version: parsed.data.version ?? "",
        description: parsed.data.description ?? "",
        visibility: parsed.data.private === true ? "private" : "public",
        assets: toAssets(parsed.data),
        built: await readBuilt(dir),
    };
}

/** The plain-text half, for a host that renders no UI at all. */
export function toText(data: AuthorData): string {
    if (!data.present) {
        return `No ${FACET_JSON} in ${data.directory}. Run facet_create to scaffold one.`;
    }
    if (data.problem !== undefined) {
        return data.problem;
    }
    const head = `${data.name} ${data.version} (${data.visibility})`;
    const lines = data.assets.map(asset =>
        asset.detail === "" ? `- ${asset.name} (${asset.type})` : `- ${asset.name} (${asset.type}) — ${asset.detail}`,
    );
    const built = data.built.map(archive => `built: dist/${archive.file} (${archive.size})`);
    return [head, data.description, ...lines, ...built].filter(line => line !== "").join("\n");
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const manifestShape = {
    directory: z
        .string()
        .trim()
        .max(1000)
        .optional()
        .describe("Facet directory to read. Defaults to the server's working directory."),
};

const manifestSchema = z.object(manifestShape);

/** Publishes `facet_manifest`, the read behind the Authoring screen. */
export function registerAuthoring(server: McpServer, deps: RegistrationDeps & AuthorDeps = {} as RegistrationDeps): void {
    const config = {
        title: "Read facet manifest",
        description:
            "Read a facet's own facet.json: its name, version, visibility, description, the assets it declares, and any archive already built into dist/.",
        inputSchema: manifestShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        const args = manifestSchema.parse(rawArgs ?? {});
        try {
            const data = await readManifest(args.directory, deps);
            return {
                content: [{ type: "text", text: toText(data) }],
                structuredContent: data as unknown as Record<string, unknown>,
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            };
        }
    };

    if (deps.supportsUi === true) {
        registerAppTool(server, "facet_manifest", { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } }, handler as never);
        return;
    }
    server.registerTool("facet_manifest", config, handler as never);
}
