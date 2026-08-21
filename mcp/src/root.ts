// Where the project is.
//
// Every project-scoped tool needs one answer to "which directory am I working
// in", and each one used to work it out from process.cwd(). That is wrong in
// any host that does not start plugins inside the user's project. Claude
// Desktop and Cowork launch the server with a cwd of their own choosing — a
// session scratch directory — so the tools read an empty folder and report,
// with complete confidence, that the project has no facets.
//
// A confident wrong answer is the worst thing this server can do, so the root
// is not just a string here. It also carries how we arrived at it, and whether
// anyone actually told us. When nobody did, callers say so out loud instead of
// returning an empty success.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** How the project root was arrived at, best evidence first. */
export type RootSource = "explicit" | "environment" | "client-roots" | "working-directory";

/** The environment variables that name a project root, in the order tried. */
export const ROOT_ENV_VARS = ["FACET_PROJECT_ROOT", "CLAUDE_PROJECT_DIR"] as const;

/** The project root, and how much we trust it. */
export interface ProjectRoot {
    path: string;
    source: RootSource;
    /**
     * The exact thing that supplied it — an env var's name, `roots/list`, or
     * `cwd`. `source` says which kind of answer won; this says which answer,
     * which is what a diagnostic line needs to be worth reading.
     */
    via: string;
    /**
     * False when nothing named a project and we fell back to the working
     * directory. An unconfirmed root is usable — it is often right in a CLI
     * session — but a caller that finds nothing there must not report "no
     * facets" as if it had looked in the right place.
     */
    confirmed: boolean;
    /**
     * Roots the client advertised that we did not pick. Empty in the ordinary
     * single-folder case; populated when a client has several folders open, so
     * the answer can name what else was on offer rather than silently choosing.
     */
    otherRoots: string[];
}

/** What the resolver needs from the outside world. Tests replace all of it. */
export interface RootDeps {
    /** An explicitly configured root. Wins over everything. */
    projectRoot?: string;
    env?: Record<string, string | undefined>;
    cwd?: () => string;
    /** Asks the client which folders it has open. Absent when it has no roots capability. */
    listRoots?: () => Promise<{ roots: { uri: string; name?: string }[] }>;
    /** True when this directory looks like a facet project. */
    hasProject?: (dir: string) => boolean;
}

/**
 * A `file://` URI as a local path, or undefined for anything else.
 *
 * Clients are supposed to advertise only file URIs, but this is untrusted
 * input from another process, so a URI we cannot turn into a path is skipped
 * rather than allowed to throw partway through resolution.
 */
export function rootUriToPath(uri: string): string | undefined {
    try {
        return uri.startsWith("file://") ? fileURLToPath(uri) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Picks one root out of what the client advertised.
 *
 * A client with several folders open gives us no single answer, so the choice
 * is made on evidence rather than position: the first folder that actually
 * looks like a facet project wins. Only when none of them do does order break
 * the tie. Either way the runners-up are carried along, so an answer built
 * from this can name them instead of pretending there was only ever one.
 */
export function chooseRoot(
    candidates: string[],
    hasProject: (dir: string) => boolean,
): { chosen: string; others: string[] } | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    const withProject = candidates.find(candidate => hasProject(candidate));
    const chosen = withProject ?? (candidates[0] as string);
    return { chosen, others: candidates.filter(candidate => candidate !== chosen) };
}

/**
 * Works out the project root once, in precedence order.
 *
 * Explicit configuration, then the environment (which is how the plugin
 * manifest passes `${CLAUDE_PROJECT_DIR}` through), then whatever folders the
 * client says it has open, and only then the working directory.
 */
export async function resolveRoot(deps: RootDeps = {}): Promise<ProjectRoot> {
    const env = deps.env ?? process.env;
    const cwd = deps.cwd ?? process.cwd;
    const hasProject = deps.hasProject ?? (() => false);

    if (deps.projectRoot !== undefined && deps.projectRoot !== "") {
        return { path: path.resolve(deps.projectRoot), source: "explicit", via: "deps.projectRoot", confirmed: true, otherRoots: [] };
    }

    for (const name of ROOT_ENV_VARS) {
        const value = env[name];
        if (value !== undefined && value.trim() !== "") {
            return { path: path.resolve(value), source: "environment", via: name, confirmed: true, otherRoots: [] };
        }
    }

    if (deps.listRoots !== undefined) {
        // The client is another process and may refuse, hang up, or answer with
        // something unusable. None of that is worth failing startup over — it
        // just means we go on to the next source.
        const listed = await deps.listRoots().catch(() => undefined);
        const candidates = (listed?.roots ?? [])
            .map(root => rootUriToPath(root.uri))
            .filter((dir): dir is string => dir !== undefined)
            .map(dir => path.resolve(dir));
        const picked = chooseRoot(candidates, hasProject);
        if (picked !== undefined) {
            return { path: picked.chosen, source: "client-roots", via: "roots/list", confirmed: true, otherRoots: picked.others };
        }
    }

    return { path: path.resolve(cwd()), source: "working-directory", via: "cwd", confirmed: false, otherRoots: [] };
}

/**
 * Holds the current root and re-resolves when the client's folders change.
 *
 * Tools read {@link current} on every call rather than closing over a path at
 * registration time, which is what lets a folder switch mid-session actually
 * take effect.
 */
export class ProjectRootHolder {
    private root: ProjectRoot;

    constructor(
        initial: ProjectRoot,
        private readonly deps: RootDeps = {},
    ) {
        this.root = initial;
    }

    current(): ProjectRoot {
        return this.root;
    }

    /** Re-runs resolution. Called on notifications/roots/list_changed. */
    async refresh(): Promise<ProjectRoot> {
        this.root = await resolveRoot(this.deps);
        return this.root;
    }
}

/**
 * Starts a holder off with a root that needs no async work.
 *
 * Registration happens synchronously, but asking the client for its roots does
 * not, so the holder opens on the best answer available without a round trip
 * and upgrades itself as soon as the client replies.
 */
export function resolveRootSync(deps: RootDeps = {}): ProjectRoot {
    const env = deps.env ?? process.env;
    const cwd = deps.cwd ?? process.cwd;

    if (deps.projectRoot !== undefined && deps.projectRoot !== "") {
        return { path: path.resolve(deps.projectRoot), source: "explicit", via: "deps.projectRoot", confirmed: true, otherRoots: [] };
    }
    for (const name of ROOT_ENV_VARS) {
        const value = env[name];
        if (value !== undefined && value.trim() !== "") {
            return { path: path.resolve(value), source: "environment", via: name, confirmed: true, otherRoots: [] };
        }
    }
    return { path: path.resolve(cwd()), source: "working-directory", via: "cwd", confirmed: false, otherRoots: [] };
}

/** The root-related fields every registrar's deps carry. */
export interface RootAware {
    projectRoot?: string;
    rootHolder?: ProjectRootHolder;
    env?: Record<string, string | undefined>;
}

/**
 * How a tool handler asks where the project is, at the moment it is called.
 *
 * Reading through a function rather than capturing a string is the whole point:
 * registration happens once, and the answer can change afterwards when the
 * client opens a different folder.
 */
export function rootReader(deps: RootAware): () => ProjectRoot {
    // An explicit root outranks the holder. Whoever passed one is stating where
    // the project is, and a client's open folder does not get to overrule that
    // — which is what makes the setting usable for tests and for embedding.
    if (deps.projectRoot !== undefined && deps.projectRoot !== "") {
        const fixed = resolveRootSync(deps);
        return () => fixed;
    }
    const holder = deps.rootHolder;
    if (holder !== undefined) {
        return () => holder.current();
    }
    const fixed = resolveRootSync(deps);
    return () => fixed;
}

/**
 * What to tell someone when the root was never confirmed and nothing was found
 * there.
 *
 * This is the sentence that replaces a confident empty list. It names the
 * directory actually read, says plainly that no workspace root was supplied,
 * and gives the two ways to fix it.
 */
export function unconfirmedRootMessage(root: ProjectRoot): string {
    return [
        `No workspace root was supplied by the host, so this read used the server's working directory: ${root.path}`,
        "That is almost certainly not your project — desktop hosts start plugins in a scratch directory.",
        "Pass `directory` explicitly, or set FACET_PROJECT_ROOT to your project path.",
    ].join("\n");
}

/**
 * One line on stderr saying what was negotiated and where the project is.
 *
 * Neither of the two things this reports can be seen from inside a session. An
 * agent sees the same tool list whether or not the host asked for UI, and it
 * sees a project root without being told which of four sources produced it —
 * so "no panel appeared" and "the project looked empty" each have two
 * indistinguishable explanations. Hosts capture plugin stderr, so this settles
 * both permanently, and costs one line at startup.
 *
 * `looksLikeProject` is the tell for the case that motivated it: a host that
 * sets CLAUDE_PROJECT_DIR to its own scratch directory satisfies the env branch
 * with a wrong value, and the only visible symptom is a project with nothing in
 * it. A root that was supplied but holds no facets.json says so here.
 */
export function describeNegotiation(input: {
    ui: boolean;
    roots: boolean;
    root: ProjectRoot;
    looksLikeProject: boolean;
}): string {
    const parts = [
        `ui-extension=${input.ui ? "yes" : "no"}`,
        `roots-capability=${input.roots ? "yes" : "no"}`,
        `root=${input.root.path}`,
        `via=${input.root.via}`,
        `confirmed=${input.root.confirmed ? "yes" : "no"}`,
        `facets-json=${input.looksLikeProject ? "found" : "absent"}`,
    ];
    if (input.root.otherRoots.length > 0) {
        parts.push(`other-roots=${input.root.otherRoots.join(",")}`);
    }
    return `facet-studio: ${parts.join(" ")}`;
}

/** How the Installed screen names where it read from. */
export function describeRoot(root: ProjectRoot): string {
    const where = {
        explicit: "configured",
        environment: `from ${root.via}`,
        "client-roots": "from the host's open folder",
        "working-directory": "the server's working directory — unconfirmed",
    }[root.source];
    const others =
        root.otherRoots.length === 0 ? "" : ` (${root.otherRoots.length} other folder${root.otherRoots.length === 1 ? "" : "s"} open)`;
    return `${root.path} · ${where}${others}`;
}
