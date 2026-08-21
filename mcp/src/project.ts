// What this project has installed.
//
// The console's Installed screen needs facts the `facet` CLI cannot give it:
// `facet list` renders an Ink view and has no `--json`, and even with one it
// prints a name and a version per row — not the assets, not whether the
// lockfile still answers the manifest. So this module reads the two files the
// CLI itself reads, `facets.json` and `facets.lock`, and reports what they say.
// Tracked upstream as `list-has-no-json`; a richer `facet list --json` would let
// this move back onto the shared argv machinery.
//
// Two rules keep that honest. Nothing here writes: every mutation still goes
// through the CLI. And nothing here reports a fact neither file states — drift
// means the manifest and the lockfile disagree, which is checkable from the two
// documents alone, and never "a materialized file changed", which is not.

import { z } from "zod";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolveDirectory } from "./tools.js";
import { rootReader, unconfirmedRootMessage, describeRoot, type RootAware } from "./root.js";
import { PANEL_RESOURCE_URI } from "./view/panel.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegistrationDeps } from "./server.js";
import { panelEnvelope, readout } from "./surface.js";

export const FACETS_JSON = "facets.json";
export const FACETS_LOCK = "facets.lock";

/**
 * A facet entry in `facets.json`: the bare source specifier, or the expanded
 * form that pairs the same specifier with materialization overrides. Both carry
 * the source in the same place, so this reads either without caring which.
 */
const ManifestEntry = z.union([z.string(), z.object({ source: z.string() }).loose()]);

const ProjectManifest = z.object({
    facets: z.record(z.string(), ManifestEntry).default({}),
}).loose();

/** One asset a lockfile entry claims the facet installed. */
const LockedAsset = z.object({
    type: z.string().optional(),
    name: z.string().optional(),
    scope: z.string().optional(),
}).loose();

const LockedSource = z.object({
    kind: z.string().optional(),
    registry: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
}).loose();

const LockedFacet = z.object({
    version: z.string().optional(),
    source: LockedSource.optional(),
    assets: z.array(LockedAsset).default([]),
}).loose();

const Lockfile = z.object({
    facets: z.record(z.string(), LockedFacet).default({}),
}).loose();

// ---------------------------------------------------------------------------
// What the Installed screen draws
// ---------------------------------------------------------------------------

/** One asset a facet put into the project. */
export interface InstalledAsset {
    type: string;
    name: string;
    /** `project` or `user` — where the adapter materialized it. */
    scope: string;
}

/** An asset-count chip, worded the way the registry words it. */
export interface InstalledCount {
    type: string;
    label: string;
}

/** One row of the installed list. */
export interface InstalledFacet {
    /** The full name, e.g. `@agentfacets/openspec-adversary`. */
    name: string;
    /** The `@scope/` prefix, or "" for an unscoped facet. */
    scope: string;
    /** The name without its scope, which is what the row leads with. */
    shortName: string;
    /** What `facets.json` asks for: `1.2.1`, `latest`, a path, a git URL. */
    declared: string;
    /** What the lockfile resolved it to, or "" when it isn't installed yet. */
    version: string;
    /** `registry`, `git`, `local`, or "" when the lockfile doesn't say. */
    origin: string;
    /** Where it came from in words: a registry host, a git URL, a path. */
    from: string;
    /** True once the lockfile carries an entry for it. */
    installed: boolean;
    assets: InstalledAsset[];
    counts: InstalledCount[];
}

/** Why the manifest and the lockfile disagree about one facet. */
export type DriftReason = "no-lockfile" | "not-installed" | "orphaned" | "version-mismatch";

/** One disagreement, in the words the banner shows. */
export interface DriftEntry {
    name: string;
    reason: DriftReason;
    detail: string;
}

/** The structured payload the panel renders as the Installed screen. */
export interface InstalledData {
    kind: "installed";
    /** The project directory's name, which is what the header shows. */
    project: string;
    /** Its full path, for the line under the header. */
    directory: string;
    /**
     * Where that path came from — configured, the environment, the host's open
     * folder, or an unconfirmed working directory. Shown under the header so a
     * wrong root is visible rather than something to deduce from an empty list.
     */
    rootLabel: string;
    /** False when there is no `facets.json` — the project has no facets at all. */
    declared: boolean;
    /** False when nothing has been installed yet. */
    locked: boolean;
    facets: InstalledFacet[];
    drift: DriftEntry[];
}

/** How the registry labels each asset type, singular and plural. */
const COUNT_LABELS: Record<string, { one: string; many: string }> = {
    skill: { one: "Skill", many: "Skills" },
    agent: { one: "Agent", many: "Agents" },
    command: { one: "Command", many: "Commands" },
    server: { one: "MCP", many: "MCP" },
};

/** The order asset types appear in, matching the registry's filter row. */
const COUNT_ORDER: readonly string[] = ["skill", "agent", "command", "server"];

/** Splits `@scope/name` into the part the row dims and the part it leads with. */
export function splitName(name: string): { scope: string; shortName: string } {
    if (!name.startsWith("@")) {
        return { scope: "", shortName: name };
    }
    const slash = name.indexOf("/");
    if (slash === -1) {
        return { scope: "", shortName: name };
    }
    return { scope: name.slice(0, slash + 1), shortName: name.slice(slash + 1) };
}

/** Turns a facet's assets into the chips the row shows, dropping the zeroes. */
export function toCounts(assets: readonly InstalledAsset[]): InstalledCount[] {
    const tally = new Map<string, number>();
    for (const asset of assets) {
        tally.set(asset.type, (tally.get(asset.type) ?? 0) + 1);
    }
    const counts: InstalledCount[] = [];
    for (const type of COUNT_ORDER) {
        const n = tally.get(type);
        if (n === undefined || n <= 0) {
            continue;
        }
        const label = COUNT_LABELS[type] ?? { one: type, many: `${type}s` };
        counts.push({ type, label: `${n} ${n === 1 ? label.one : label.many}` });
    }
    return counts;
}

/** The source specifier of a manifest entry, whichever form it takes. */
function specifierOf(entry: z.infer<typeof ManifestEntry>): string {
    return typeof entry === "string" ? entry : entry.source;
}

/** Where a locked facet came from, said in one short phrase. */
function describeSource(source: z.infer<typeof LockedSource> | undefined): { origin: string; from: string } {
    if (source === undefined) {
        return { origin: "", from: "" };
    }
    const kind = source.kind ?? "";
    const from = source.registry ?? source.url ?? source.path ?? "";
    return { origin: kind, from };
}

/** An exact `1.2.3`, which is the only spec shape we compare against a lock. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Every way the manifest and the lockfile disagree.
 *
 * Deliberately narrow on versions: a range or `latest` is satisfied by more
 * than one lockfile entry, and working out which ones needs the semver rules
 * that live in the engine. So only an exact pin is checked here — a spec this
 * module can be sure about — and everything looser is left alone rather than
 * guessed at. A wrong drift banner is worse than a missing one, because Repair
 * reinstalls the project.
 */
export function detectDrift(
    declared: ReadonlyMap<string, string>,
    locked: ReadonlyMap<string, string>,
    lockfileExists: boolean,
): DriftEntry[] {
    if (declared.size === 0) {
        return [];
    }
    if (!lockfileExists) {
        return [{
            name: "",
            reason: "no-lockfile",
            detail: `${FACETS_JSON} declares ${declared.size} ${declared.size === 1 ? "facet" : "facets"}, and there is no ${FACETS_LOCK} yet.`,
        }];
    }

    const drift: DriftEntry[] = [];
    for (const [name, spec] of declared) {
        const version = locked.get(name);
        if (version === undefined) {
            drift.push({ name, reason: "not-installed", detail: `${name} is declared as ${spec} but nothing is locked for it.` });
            continue;
        }
        if (EXACT_VERSION.test(spec) && spec !== version) {
            drift.push({ name, reason: "version-mismatch", detail: `${name} is declared as ${spec} but ${version} is locked.` });
        }
    }
    for (const name of locked.keys()) {
        if (!declared.has(name)) {
            drift.push({ name, reason: "orphaned", detail: `${name} is locked but ${FACETS_JSON} no longer declares it.` });
        }
    }
    return drift;
}

/** Reads a JSON file, or reports that it isn't there. */
async function readJson(file: string): Promise<{ found: boolean; value?: unknown; error?: string }> {
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch (error) {
        // Anything other than "no such file" is a real problem worth naming.
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") {
            return { found: false };
        }
        return { found: false, error: `${path.basename(file)} could not be read: ${(error as Error).message}` };
    }
    try {
        return { found: true, value: JSON.parse(text) };
    } catch (error) {
        return { found: true, error: `${path.basename(file)} is not valid JSON: ${(error as Error).message}` };
    }
}

export interface ProjectDeps extends RootAware {
    /** The root every path is resolved under. Defaults to the process's cwd. */
    projectRoot?: string;
}

/**
 * Reads one project's installed state.
 *
 * A malformed file is reported as drift rather than thrown: a project whose
 * lockfile got mangled is exactly when someone needs the screen most, and an
 * empty list beside a banner saying so is more use than an error.
 */
export async function readProject(directory: string | undefined, deps: ProjectDeps = {}): Promise<InstalledData> {
    const resolvedRoot = rootReader(deps)();
    const root = resolvedRoot.path;
    const resolved = resolveDirectory(root, directory);
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    const dir = resolved.path;

    const manifestFile = await readJson(path.join(dir, FACETS_JSON));
    const lockFile = await readJson(path.join(dir, FACETS_LOCK));

    const manifest = manifestFile.value === undefined ? undefined : ProjectManifest.safeParse(manifestFile.value);
    const lock = lockFile.value === undefined ? undefined : Lockfile.safeParse(lockFile.value);

    const declaredEntries = manifest?.success === true ? manifest.data.facets : {};
    const lockedEntries = lock?.success === true ? lock.data.facets : {};

    const declared = new Map(Object.entries(declaredEntries).map(([name, entry]) => [name, specifierOf(entry)]));
    const lockedVersions = new Map(
        Object.entries(lockedEntries).map(([name, entry]) => [name, entry.version ?? ""]),
    );

    // Everything the two files know about, declared first and in their order,
    // then whatever the lockfile still carries on its own.
    const names = [...declared.keys(), ...[...lockedVersions.keys()].filter(name => !declared.has(name))];

    const facets: InstalledFacet[] = names.map(name => {
        const locked = lockedEntries[name];
        const assets: InstalledAsset[] = (locked?.assets ?? [])
            .filter(asset => typeof asset.name === "string" && asset.name !== "")
            .map(asset => ({
                type: asset.type ?? "unknown",
                name: asset.name ?? "",
                scope: asset.scope ?? "",
            }));
        const { scope, shortName } = splitName(name);
        const { origin, from } = describeSource(locked?.source);
        return {
            name,
            scope,
            shortName,
            declared: declared.get(name) ?? "",
            version: locked?.version ?? "",
            origin,
            from,
            installed: locked !== undefined,
            assets,
            counts: toCounts(assets),
        };
    });

    const drift = detectDrift(declared, lockedVersions, lockFile.found);

    // A file we could not read at all is its own kind of disagreement, and it
    // leads, because nothing below it can be trusted while it stands.
    const broken: DriftEntry[] = [];
    for (const [file, result, parsed] of [
        [FACETS_JSON, manifestFile, manifest] as const,
        [FACETS_LOCK, lockFile, lock] as const,
    ]) {
        if (result.error !== undefined) {
            broken.push({ name: "", reason: "no-lockfile", detail: result.error });
        } else if (parsed?.success === false) {
            broken.push({ name: "", reason: "no-lockfile", detail: `${file} does not match the shape facet writes.` });
        }
    }

    return {
        kind: "installed",
        project: path.basename(dir),
        directory: dir,
        rootLabel: describeRoot(resolvedRoot),
        declared: manifestFile.found,
        locked: lockFile.found,
        facets,
        drift: [...broken, ...drift],
    };
}

/** The plain-text half, for a host that renders no UI at all. */
export function toText(data: InstalledData): string {
    if (!data.declared) {
        // Always say where this was read and what pointed us there. An absence
        // is only meaningful alongside the place it was observed, and the whole
        // Defect A failure was an absence reported as if the place were obvious.
        // A host that sets its own scratch directory as the project dir gets a
        // true sentence naming that directory, rather than a verdict on the
        // user's real project.
        const provenance = data.rootLabel === "" ? data.directory : data.rootLabel;
        return [
            `No ${FACETS_JSON} in ${data.directory}.`,
            `That directory came from: ${provenance}.`,
            "If that is not your project, pass `directory`, or set FACET_PROJECT_ROOT to the right path.",
        ].join("\n");
    }
    if (data.facets.length === 0) {
        return `${FACETS_JSON} in ${data.directory} declares no facets.`;
    }
    const rows = data.facets.map(facet => {
        const version = facet.installed ? facet.version : `${facet.declared} (not installed)`;
        const counts = facet.counts.map(count => count.label).join(", ");
        return counts === "" ? `- ${facet.name} ${version}` : `- ${facet.name} ${version} — ${counts}`;
    });
    const head = `${data.facets.length} ${data.facets.length === 1 ? "facet" : "facets"} in ${data.project}:`;
    const tail = data.drift.map(entry => `! ${entry.detail}`);
    return [head, ...rows, ...tail].join("\n");
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const projectShape = {
    directory: z
        .string()
        .trim()
        .max(1000)
        .optional()
        .describe("Project directory to read. Defaults to the server's working directory."),
};

const projectSchema = z.object(projectShape);

/**
 * Publishes `facet_project`, the read the console opens with.
 *
 * Read-only and offline: it opens two files and closes them. That is what lets
 * the panel call it after every mutation without asking anyone's permission.
 */
export function registerProject(server: McpServer, deps: RegistrationDeps & ProjectDeps = {} as RegistrationDeps): void {
    const config = {
        title: "Installed facets",
        description:
            "Read what this project has installed: the facets facets.json declares, the versions facets.lock resolved, the assets each one carries, and any disagreement between the two files. Only for questions about this project — a question about what exists or is available is facet_browse's, and needs no call here.",
        inputSchema: projectShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
        const args = projectSchema.parse(rawArgs ?? {});
        try {
            const data = await readProject(args.directory, deps);

            // The empty answer is the dangerous one. "declared: false, facets:
            // []" reads as a fact about the user's project, and when the root
            // was never confirmed it is a fact about a scratch directory
            // instead. Say which directory was read and how to name the right
            // one, rather than reporting an absence we cannot vouch for.
            const root = rootReader(deps)();
            if (!root.confirmed && args.directory === undefined && !data.declared) {
                return {
                    content: [{ type: "text", text: unconfirmedRootMessage(root) }],
                    isError: true,
                };
            }
            const count = data.facets.length === 1 ? "1 facet" : `${data.facets.length} facets`;
            const brief = `${count} installed in ${data.directory}, in the panel's Installed screen.`;
            return panelEnvelope(deps.supportsUi, {
                text: readout(deps.supportsUi, brief, () => toText(data)),
                payload: data as unknown as Record<string, unknown>,
                summary: {
                    kind: "installed-summary",
                    directory: data.directory,
                    count: data.facets.length,
                    names: data.facets.map(f => f.name),
                    drift: data.drift.length,
                },
            });
        } catch (error) {
            return {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            };
        }
    };

    if (deps.supportsUi === true) {
        registerAppTool(server, "facet_project", { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } }, handler as never);
        return;
    }
    server.registerTool("facet_project", config, handler as never);
}
