// The nine lifecycle tools facet-studio exposes: thin, headless wrappers around
// the `facet` CLI.
//
// Everything here obeys one rule above all others: a user-supplied value is
// validated by zod and then handed to the child process as ONE element of an
// argv array. No command string is ever built, so there is no shell for a value
// like `; rm -rf ~` to be interpreted by. Values that merely *look* like flags
// (anything starting with `-`) are rejected too, because argv arrays protect you
// from the shell but not from the CLI's own option parser.
//
// Directory arguments get the same treatment from the other direction: they are
// resolved against the project root and refused if the result lands outside it,
// symlinks included — and checked a second time right before the spawn, so a
// symlink dropped in after we approved the path doesn't get to ride along.
//
// The second rule is about what we say afterwards. Everything in a result comes
// from the command that ran and nowhere else. We never open a file to pad a
// result out, because a fact the command didn't report is a fact the caller
// didn't ask for — and on a private project that fact might be a secret.

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { scrubSecrets } from "./auth.js";
import { panelShows } from "./surface.js";
import { rootReader, unconfirmedRootMessage, type ProjectRoot } from "./root.js";
import type { RegistrationDeps } from "./server.js";

/** The panel every tool points at. mcp-panels registers the resource itself. */
export const PANEL_RESOURCE_URI = "ui://facet-studio/panel.html";

/** How long a `facet` invocation may run before we give up on it. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Room for a large build payload; the default 1 MB truncates real facets. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Longest a single name segment may be — scope and name are measured apart. */
const MAX_NAME_PART = 64;

const SCOPED_NAME = /^(@[a-z](-?[a-z0-9])*\/)?[a-z](-?[a-z0-9])*$/;
const PLAIN_NAME = /^[a-z](-?[a-z0-9])*$/;
const VERSION = /^[0-9*][0-9A-Za-z.*-]*$/;
// Control characters, NUL and DEL included. Never legitimate in a value we
// forward to the CLI, and a cheap way to catch anything smuggled in.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** True when every `/`-separated part of a name is within the length limit. */
function partsWithinLimit(value: string): boolean {
    return value.split("/").every(part => part.length > 0 && part.length <= MAX_NAME_PART);
}

/**
 * A facet name, optionally scoped. Lowercase kebab only, which is why
 * `--force`, `; rm -rf ~` and `../evil` can never survive this check.
 */
export const facetNameSchema = z
    .string()
    .regex(SCOPED_NAME, "must be a lowercase facet name, optionally @scoped")
    .refine(partsWithinLimit, `each name part must be 1-${MAX_NAME_PART} characters`);

/** An asset name (skill / agent / command). Same rules, but never scoped. */
export const assetNameSchema = z
    .string()
    .regex(PLAIN_NAME, "must be a lowercase asset name")
    .max(MAX_NAME_PART, `must be at most ${MAX_NAME_PART} characters`);

/** A version or version range, as the registry writes them. */
export const versionSchema = z
    .string()
    .regex(VERSION, "must start with a digit or * and contain only version characters")
    .max(MAX_NAME_PART, `must be at most ${MAX_NAME_PART} characters`);

/** Free text we pass straight through, minus anything that could pose as a flag. */
export const descriptionSchema = z
    .string()
    .min(1)
    .max(500)
    .refine(value => !value.startsWith("-"), "must not start with '-'")
    .refine(value => !CONTROL_CHARS.test(value), "must not contain control characters");

/**
 * A directory, relative to the project root. The regex work here is only the
 * first gate — {@link resolveDirectory} does the real containment check.
 */
export const directorySchema = z
    .string()
    .min(1)
    .max(512)
    .refine(value => !value.startsWith("-"), "must not start with '-'")
    .refine(value => !CONTROL_CHARS.test(value), "must not contain control characters");

const directoryField = directorySchema
    .optional()
    .describe(
        "Directory inside the project root. Defaults to the root itself — omit it unless the user names one; a path outside the project root is refused.",
    );
const verboseField = z.boolean().optional().describe("Ask the CLI for detailed step output on stderr.");
const acceptMcpField = z
    .boolean()
    .optional()
    .describe("Approve any MCP server configuration this operation writes. Off by default: leaving it off makes the CLI refuse rather than silently rewrite host config.");

/** Every tool takes an optional directory, so the arg tables all start here. */
const listArgs = z.object({ directory: directoryField });

const verifyArgs = z.object({ directory: directoryField });

const buildArgs = z.object({
    directory: directoryField,
    emitManifest: z.boolean().optional().describe("Also write a loose build-manifest.json next to the .facet file."),
});

const createArgs = z.object({
    name: facetNameSchema.describe("Name of the new facet."),
    description: descriptionSchema.optional(),
    version: versionSchema.optional().describe("Semver for the new facet. Defaults to 0.0.0."),
    private: z.boolean().optional().describe("Mark the facet private."),
    skills: z.array(assetNameSchema).max(50).optional().describe("Skills to scaffold."),
    agents: z.array(assetNameSchema).max(50).optional().describe("Agents to scaffold."),
    commands: z.array(assetNameSchema).max(50).optional().describe("Commands to scaffold."),
    readme: z.boolean().optional().describe("Scaffold a README.md. On by default."),
    force: z.boolean().optional().describe("Overwrite an existing facet.json."),
    directory: directoryField,
});

const modifyArgs = z
    .object({
        target: z.enum(["skill", "agent", "command", "facet"]).describe("What to edit."),
        name: assetNameSchema.optional().describe("The asset to edit. Required unless target is 'facet'."),
        add: z.boolean().optional().describe("Scaffold the asset and add its manifest entry."),
        remove: z.boolean().optional().describe("Delete the asset file and its manifest entry."),
        rename: assetNameSchema.optional().describe("New name for the asset."),
        description: descriptionSchema.optional().describe("New description for the asset, or for the facet itself."),
        facetName: facetNameSchema.optional().describe("New facet name. Only valid when target is 'facet'."),
        version: versionSchema.optional().describe("New facet version. Only valid when target is 'facet'."),
        private: z.boolean().optional().describe("Set the facet's private flag. Only valid when target is 'facet'."),
        directory: directoryField,
    })
    // The CLI reads `modify <target> [name] [directory]` positionally, so an
    // asset edit that omits the name would silently consume the directory as
    // the name. Refusing the ambiguous shape outright is the only safe move.
    .refine(args => args.target === "facet" || args.name !== undefined, {
        error: "name is required unless target is 'facet'",
        path: ["name"],
    })
    .refine(args => args.target !== "facet" || args.name === undefined, {
        error: "the 'facet' target edits the facet itself, so it takes no asset name",
        path: ["name"],
    })
    .refine(args => args.target !== "facet" || (args.add === undefined && args.remove === undefined && args.rename === undefined), {
        error: "add / remove / rename apply to assets, not to the facet itself",
        path: ["target"],
    })
    .refine(args => args.target === "facet" || (args.facetName === undefined && args.version === undefined && args.private === undefined), {
        error: "facetName / version / private are only valid when target is 'facet'",
        path: ["target"],
    })
    // The CLI's `--private` is a presence-only switch: it sets the flag, and there
    // is no counterpart that clears it. So `private: false` has no honest
    // translation, and the worst thing we could do is send `--private` anyway and
    // hand the caller the exact opposite of what they asked for. We refuse instead.
    .refine(args => args.private !== false, {
        error: "the facet CLI can set the private flag but has no operation to clear it, so private cannot be false; edit facet.json directly to make a facet public again",
        path: ["private"],
    });

const addArgs = z.object({
    name: facetNameSchema.describe("Facet to add, by registry name."),
    version: versionSchema.optional().describe("Version or range. Defaults to the latest release."),
    verbose: verboseField,
    acceptMcp: acceptMcpField,
    directory: directoryField,
});

const updateArgs = z.object({
    name: facetNameSchema.describe("Installed facet to move, by registry name."),
    version: versionSchema.optional().describe("Version or range to move it to. Defaults to the latest release."),
    verbose: verboseField,
    acceptMcp: acceptMcpField,
    directory: directoryField,
});

const installArgs = z.object({
    frozenLockfile: z.boolean().optional().describe("Treat facets.lock as the source of truth and fail on drift."),
    verbose: verboseField,
    acceptMcp: acceptMcpField,
    directory: directoryField,
});

const removeArgs = z.object({
    name: facetNameSchema.describe("Facet to remove, by name."),
    verbose: verboseField,
    acceptMcp: acceptMcpField,
    directory: directoryField,
});

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** One request to run the CLI: the arguments, and where to run them. */
export interface CliInvocation {
    /** CLI arguments only — the binary itself is not part of this. */
    argv: readonly string[];
    cwd: string;
}

/** What came back from the CLI, including the ways it can fail to run at all. */
export interface CliResult {
    /** Process exit code, or null when it never got far enough to have one. */
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** Set when the process didn't complete normally. */
    failure?: "timeout" | "not-found" | "spawn";
}

/** The seam tests replace to watch argv without touching a real process. */
export type RunCli = (invocation: CliInvocation) => Promise<CliResult>;

/** What the registrar needs. Extends the server's own registration deps. */
export interface ToolDeps extends Partial<RegistrationDeps> {
    /** Root every directory argument is resolved under. Defaults to the cwd. */
    projectRoot?: string;
    /** Name or path of the CLI binary. */
    facetBin?: string;
    /** Override the spawn seam (tests do this). */
    runCli?: RunCli;
    timeoutMs?: number;
}

interface ExecFailure {
    code?: number | string;
    killed?: boolean;
    signal?: string | null;
}

/**
 * The real spawner: `execFile` with an argv array, never a shell. Colour is
 * turned off so the JSON we parse isn't laced with escape sequences.
 */
export function createCliRunner(bin: string, timeoutMs: number): RunCli {
    return ({ argv, cwd }) =>
        new Promise<CliResult>(resolve => {
            const args = argv.map(String);
            execFile(
                bin,
                args,
                {
                    cwd,
                    timeout: timeoutMs,
                    maxBuffer: MAX_OUTPUT_BYTES,
                    windowsHide: true,
                    shell: false,
                    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
                },
                (error, stdout, stderr) => {
                    if (error === null) {
                        resolve({ exitCode: 0, stdout, stderr });
                        return;
                    }
                    const failed = error as unknown as ExecFailure;
                    const exitCode = typeof failed.code === "number" ? failed.code : null;
                    let failure: CliResult["failure"];
                    if (failed.killed === true || failed.signal != null) {
                        failure = "timeout";
                    } else if (failed.code === "ENOENT") {
                        failure = "not-found";
                    } else if (exitCode === null) {
                        failure = "spawn";
                    }
                    resolve({
                        exitCode,
                        stdout,
                        stderr: stderr.length > 0 ? stderr : error.message,
                        ...(failure === undefined ? {} : { failure }),
                    });
                },
            );
        });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ToolErrorCode = "invalid_input" | "no_project_root" | "cli_not_found" | "timeout" | "cli_failed" | "unreadable_output";

export interface ToolError {
    code: ToolErrorCode;
    message: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
}

/** What a tool puts in its text content: success with data, or a typed error. */
export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: ToolError };

function fail(code: ToolErrorCode, message: string, extra: Omit<ToolError, "code" | "message"> = {}): ToolOutcome {
    return { ok: false, error: { code, message, ...extra } };
}

/** One row of the panel's asset table. */
export interface ToolAsset {
    /** skill / agent / command, or `file` for anything we can't classify. */
    type: string;
    name: string;
    detail?: string;
}

/**
 * The summary the panel draws its card from.
 *
 * These are the fields the view looks for, so the names have to match what it
 * reads — see `toPanelData` in view/panel.ts. We spell the shape out here rather
 * than importing the view's type, so the server never has to pull the browser
 * half of the panel into its module graph.
 */
export type ToolPresentation = {
    facet: string;
    operation: string;
    status: "success" | "error";
    message: string;
    assets: ToolAsset[];
};

/** What the renderer needs to describe a run beyond the outcome itself. */
export interface OutcomeContext {
    /** Human label for the operation, e.g. "Verify facet". */
    operation: string;
    /** The resolved directory the run acted on. Only ever used for its name. */
    directory: string;
    /** Whether the host renders the panel, which changes what the text says. */
    supportsUi?: boolean;
}

/**
 * Renders an outcome as tool content.
 *
 * Two views of one run, and the important thing is that they are two views of
 * the *same* run. The text part is the whole payload and never changes shape,
 * so a host with no panel still sees everything. Alongside it goes the summary
 * the panel card is built from — the same facts, arranged for a reader rather
 * than a parser, and drawn from nowhere else.
 *
 * Both go through the same scrub on the way out, so a credential the CLI echoed
 * back at us cannot show up in one channel while the other looks clean.
 */
export function renderOutcome(outcome: ToolOutcome, context: OutcomeContext): CallToolResult {
    const summary = summarize(outcome, context);
    // On a host with the panel, the strip along its top already reports this
    // run, so the text is one clean line instead of the whole payload. Both
    // views are built from the same scrubbed summary either way. A failure
    // stays a plain sentence — the model relaying why something failed is
    // exactly what should happen, so no note tells it to hold back.
    const brief = `${summary.operation} ${summary.status === "success" ? "succeeded" : "failed"}: ${summary.message}`;
    const uiText = outcome.ok ? panelShows(brief) : brief;
    return {
        content: [
            {
                type: "text",
                text: context.supportsUi === true ? uiText : scrubSecrets(JSON.stringify(outcome, null, 2)),
            },
        ],
        structuredContent: summary,
        ...(outcome.ok ? {} : { isError: true }),
    };
}

/** The scrub every string takes before it can be shown to anyone. */
function clean(value: string): string {
    return scrubSecrets(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field of a record, but only when it is a string with something in it. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
    const value = source[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Which facet this run was about.
 *
 * The CLI names it in most `--json` payloads, but not all of them: `modify`
 * reports only what changed, and the text commands report prose. When it doesn't
 * say, we fall back to the name of the directory the caller pointed us at.
 *
 * Reading the name out of facet.json would give a prettier answer, and we used
 * to. It's the wrong answer: it puts a fact on the card that the command never
 * reported, and once you're willing to open that file to fill one gap there is
 * no principled place to stop. The directory name is something the caller
 * already knows, which makes it honest even when it's dull.
 */
function facetNameFor(data: unknown, directory: string): string {
    const fromCli = isRecord(data) ? stringField(data, "name") : undefined;
    const base = path.basename(directory);
    return fromCli ?? (base.length > 0 ? base : directory);
}

/** How the CLI lays its assets out on disk, so a file path can name its kind. */
const ASSET_FILE_PATTERNS: readonly { pattern: RegExp; type: string }[] = [
    { pattern: /^skills\/([^/]+)\/SKILL\.md$/, type: "skill" },
    { pattern: /^agents\/([^/]+)\.md$/, type: "agent" },
    { pattern: /^commands\/([^/]+)\.md$/, type: "command" },
];

/**
 * The rows of the card's table: the files this run reported touching, and only
 * those.
 *
 * A command that reports no files gets an empty table. That looks like less of a
 * card, and it is — but a table listing everything the facet happens to contain
 * would be describing a different question than the one the caller asked, and
 * `facet list` in particular would show rows it never produced.
 */
function assetsFor(data: unknown): ToolAsset[] {
    const files = isRecord(data) ? stringArray(data["files"]) : [];
    return files.map(file => {
        for (const { pattern, type } of ASSET_FILE_PATTERNS) {
            const name = file.match(pattern)?.[1];
            if (name !== undefined) {
                return { type, name: clean(name), detail: clean(file) };
            }
        }
        return { type: "file", name: clean(file) };
    });
}

/** A line about how it went, in the CLI's own words wherever it gave us any. */
function successMessage(data: unknown): string {
    if (isRecord(data)) {
        const changes = stringArray(data["changes"]);
        if (changes.length > 0) {
            return changes.join("; ");
        }
        const output = stringField(data, "output");
        if (output !== undefined) {
            return output;
        }
    }
    return "Completed successfully.";
}

/**
 * Boils one finished run down to the handful of fields the card draws.
 *
 * Every field here traces back to this run: what the caller asked for, what the
 * CLI answered, and how it went. Nothing is read off disk to fill a gap, so
 * whatever the card shows, the text payload beside it accounts for.
 */
function summarize(outcome: ToolOutcome, context: OutcomeContext): ToolPresentation {
    const data = outcome.ok ? outcome.data : undefined;

    return {
        facet: clean(facetNameFor(data, context.directory)),
        operation: clean(context.operation),
        status: outcome.ok ? "success" : "error",
        // On the way out we hand over the CLI's own sentence, not a dump of the
        // error object — the card has one line for this and it should read.
        message: clean(outcome.ok ? successMessage(data) : outcome.error.message),
        assets: outcome.ok ? assetsFor(data) : [],
    };
}

/** How to turn a finished CLI run into an outcome. */
type OutputMode = "json" | "text";

function trimOutput(value: string): string {
    return value.trim();
}

function interpret(result: CliResult, mode: OutputMode): ToolOutcome {
    if (result.failure === "not-found") {
        return fail("cli_not_found", "The facet CLI could not be found on PATH.", { stderr: trimOutput(result.stderr) });
    }
    if (result.failure === "timeout") {
        return fail("timeout", "The facet CLI did not finish in time and was terminated.", {
            stdout: trimOutput(result.stdout),
            stderr: trimOutput(result.stderr),
        });
    }
    if (result.failure === "spawn") {
        return fail("cli_failed", "The facet CLI could not be started.", { stderr: trimOutput(result.stderr) });
    }

    const stdout = trimOutput(result.stdout);
    const stderr = trimOutput(result.stderr);

    if (result.exitCode !== 0) {
        // Failures are plain text on stderr, but a command that got far enough
        // may still have printed usable JSON. Keep whichever we have.
        return fail("cli_failed", firstLine(stderr) || firstLine(stdout) || `The facet CLI exited with code ${String(result.exitCode)}.`, {
            exitCode: result.exitCode,
            ...(stdout.length > 0 ? { stdout } : {}),
            ...(stderr.length > 0 ? { stderr } : {}),
        });
    }

    if (mode === "text") {
        return { ok: true, data: { output: stdout, ...(stderr.length > 0 ? { details: stderr } : {}) } };
    }

    try {
        return { ok: true, data: JSON.parse(stdout) };
    } catch {
        return fail("unreadable_output", "The facet CLI succeeded but its --json output could not be parsed.", { stdout, ...(stderr.length > 0 ? { stderr } : {}) });
    }
}

function firstLine(value: string): string {
    return value.split("\n", 1)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Directory containment
// ---------------------------------------------------------------------------

export type DirectoryResolution = { ok: true; path: string } | { ok: false; message: string };

/** A path resolved as far as the filesystem allows, or the reason we gave up. */
type PathLookup =
    | {
          ok: true;
          /** Where the path ends up once every symlink that exists today is followed. */
          full: string;
          /** The deepest ancestor that exists right now, itself fully resolved. */
          existing: string;
      }
    | { ok: false; reason: string };

/**
 * Resolves a directory argument under the project root, refusing anything that
 * lands outside it.
 *
 * The path may not exist yet (that's the normal case for `facet create`), so we
 * resolve the deepest part that does exist through its symlinks and rebuild the
 * rest on top. That way a symlinked subdirectory pointing at /etc is caught,
 * not just a literal `../..`.
 *
 * Two things get checked, not one. The obvious one is where the whole path ends
 * up. The other is where its *existing* part ends up, because that part is the
 * only place someone could drop a symlink to redirect us — and if the project
 * root itself doesn't exist, the deepest thing that does exist sits above the
 * root, which is exactly the swap we refuse to be set up for.
 */
export function resolveDirectory(projectRoot: string, directory: string | undefined): DirectoryResolution {
    const rootLookup = lookUpPath(path.resolve(projectRoot));
    if (!rootLookup.ok) {
        return { ok: false, message: `the project root ${rootLookup.reason}` };
    }
    const root = rootLookup.full;

    const label = directory ?? ".";
    const target = lookUpPath(path.resolve(root, label));
    if (!target.ok) {
        return { ok: false, message: `directory "${label}" ${target.reason}` };
    }
    if (!isInside(root, target.existing) || !isInside(root, target.full)) {
        return { ok: false, message: `directory "${label}" resolves outside the project root` };
    }
    return { ok: true, path: target.full };
}

/**
 * Checks that an already-approved directory is still the same directory.
 *
 * The first check answers "where does this path lead?" — but that answer has a
 * shelf life. Between approving a path and handing it to a child process,
 * anything else on the machine can delete that directory and put a symlink to
 * somewhere else in its place, and the CLI would follow it.
 *
 * So we ask again at the last possible moment, and insist on the same answer.
 * The path we re-check is the resolved one, which is also the one the CLI gets,
 * so there is no second interpretation to go wrong. This narrows the window to
 * the spawn itself rather than closing it outright — that's as tight as it goes
 * without the child opening the directory for us.
 */
function reconfirmDirectory(projectRoot: string, resolved: string): DirectoryResolution {
    const again = resolveDirectory(projectRoot, resolved);
    if (!again.ok) {
        return again;
    }
    if (again.path !== resolved) {
        return { ok: false, message: `directory "${resolved}" changed while the command was being prepared` };
    }
    return again;
}

/** True when `candidate` is the root itself or sits somewhere beneath it. */
function isInside(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * `realpath` for a path that may not exist yet: resolve what does, keep the rest.
 *
 * A segment is only allowed to be treated as "not there yet" when the OS really
 * says it isn't there. If the lookup fails any other way — a permission wall, a
 * symlink loop — or if the segment turns out to exist as a link we couldn't
 * follow, we stop and say so. Quietly falling back to the literal path would
 * mean approving a path without ever learning where it points.
 */
function lookUpPath(target: string): PathLookup {
    const missing: string[] = [];
    let current = target;
    for (;;) {
        try {
            const existing = realpathSync(current);
            return { ok: true, existing, full: path.join(existing, ...[...missing].reverse()) };
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                return { ok: false, reason: `could not be resolved (${code ?? "unknown error"})` };
            }
            if (entryExists(current)) {
                // Something is there, but `realpath` still couldn't say where it
                // leads — a dangling or circular symlink. Never walk past it.
                return { ok: false, reason: "contains a link that does not lead anywhere we can check" };
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return { ok: false, reason: "has no existing ancestor to resolve it against" };
            }
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

/** Is there an entry at this path at all? Asked without following any link. */
function entryExists(target: string): boolean {
    try {
        lstatSync(target);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// The tool table
// ---------------------------------------------------------------------------

/**
 * Where the resolved directory goes. Commands that accept a directory argument
 * take it positionally; the rest simply run inside it.
 */
type DirectoryMode = "positional" | "cwd";

export interface ToolSpec {
    name: string;
    title: string;
    description: string;
    /** Full schema, including cross-field rules the raw shape can't carry. */
    schema: z.ZodType<Record<string, unknown>>;
    /** The per-field shape handed to the MCP SDK for the published inputSchema. */
    shape: Record<string, z.ZodType>;
    annotations: ToolAnnotations;
    output: OutputMode;
    directoryMode: DirectoryMode;
    /** Builds the argv array. `dir` is the already-validated absolute directory. */
    argv: (args: never, dir: string) => string[];
    /**
     * True for tools whose empty answer is a claim about the project — "no
     * facets installed". Those must not run against a root nobody confirmed,
     * because the answer would be a confident falsehood.
     */
    reportsAbsence?: boolean;
}

interface SpecInput<S extends z.ZodType<Record<string, unknown>>> {
    name: string;
    title: string;
    description: string;
    schema: S;
    shape: Record<string, z.ZodType>;
    annotations: ToolAnnotations;
    output: OutputMode;
    directoryMode: DirectoryMode;
    argv: (args: z.infer<S>, dir: string) => string[];
}

/** Ties a spec's schema to its argv builder, then erases the pairing once. */
function defineTool<S extends z.ZodType<Record<string, unknown>>>(spec: SpecInput<S>): ToolSpec {
    return { ...spec, argv: (args, dir) => spec.argv(args as z.infer<S>, dir) };
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const MUTATES_ONLINE: ToolAnnotations = { ...MUTATES, openWorldHint: true };

/** `--verbose` / `--accept-mcp`, shared by add / update / install / remove. */
function projectFlags(args: { verbose?: boolean; acceptMcp?: boolean }): string[] {
    return [...(args.verbose === true ? ["--verbose"] : []), ...(args.acceptMcp === true ? ["--accept-mcp"] : [])];
}

function repeated(flag: string, values: readonly string[] | undefined): string[] {
    return (values ?? []).flatMap(value => [flag, value]);
}

/** Every tool this server exposes, in the order hosts see them. */
export const TOOL_SPECS: readonly ToolSpec[] = [
    defineTool({
        name: "facet_list",
        title: "List facets",
        description:
            "List the facets a project declares, with their resolved versions. Only for questions about this project — a question about what exists or is available is facet_browse's, and needs no call here.",
        schema: listArgs,
        shape: listArgs.shape,
        annotations: READ_ONLY,
        output: "text",
        directoryMode: "cwd",
        argv: () => ["list"],
        reportsAbsence: true,
    }),
    defineTool({
        name: "facet_verify",
        title: "Verify facet",
        description: "Validate a facet without writing any output. Use this before build or publish.",
        schema: verifyArgs,
        shape: verifyArgs.shape,
        annotations: READ_ONLY,
        output: "json",
        directoryMode: "positional",
        argv: (_args, dir) => ["build", "--verify", "--json", dir],
    }),
    defineTool({
        name: "facet_build",
        title: "Build facet",
        description: "Build a facet, writing the .facet artifact into dist/.",
        schema: buildArgs,
        shape: buildArgs.shape,
        annotations: MUTATES,
        output: "json",
        directoryMode: "positional",
        argv: (args, dir) => ["build", "--json", ...(args.emitManifest === true ? ["--emit-manifest"] : []), dir],
    }),
    defineTool({
        name: "facet_create",
        title: "Create facet",
        description: "Scaffold a new facet project, optionally with starter skills, agents and commands.",
        schema: createArgs,
        shape: createArgs.shape,
        annotations: MUTATES,
        output: "json",
        directoryMode: "positional",
        argv: (args, dir) => [
            "create",
            "--json",
            "--name",
            args.name,
            ...(args.description === undefined ? [] : ["--description", args.description]),
            ...(args.version === undefined ? [] : ["--version", args.version]),
            ...(args.private === true ? ["--private"] : []),
            ...repeated("--skill", args.skills),
            ...repeated("--agent", args.agents),
            ...repeated("--command", args.commands),
            ...(args.readme === false ? ["--no-readme"] : []),
            ...(args.force === true ? ["--force"] : []),
            dir,
        ],
    }),
    defineTool({
        name: "facet_modify",
        title: "Modify facet",
        description: "Make a headless edit to a facet: add, remove, rename or describe an asset, or change the facet's own fields.",
        schema: modifyArgs,
        shape: modifyArgs.def.shape,
        annotations: MUTATES,
        output: "json",
        directoryMode: "positional",
        argv: (args, dir) => [
            "modify",
            args.target,
            ...(args.name === undefined ? [] : [args.name]),
            ...(args.add === true ? ["--add"] : []),
            ...(args.remove === true ? ["--remove"] : []),
            ...(args.rename === undefined ? [] : ["--rename", args.rename]),
            ...(args.description === undefined ? [] : ["--description", args.description]),
            ...(args.facetName === undefined ? [] : ["--name", args.facetName]),
            ...(args.version === undefined ? [] : ["--version", args.version]),
            // Only `true` earns the flag. The schema already turns `false` away, and
            // this second `=== true` is what makes sure it stays that way.
            ...(args.private === true ? ["--private"] : []),
            "--json",
            dir,
        ],
    }),
    defineTool({
        name: "facet_add",
        title: "Add facet",
        description: "Add a facet from the registry to the project and install it.",
        schema: addArgs,
        shape: addArgs.shape,
        annotations: MUTATES_ONLINE,
        output: "text",
        directoryMode: "cwd",
        argv: args => ["add", args.version === undefined ? args.name : `${args.name}@${args.version}`, ...projectFlags(args)],
    }),
    // The CLI has no `update` subcommand: the documented way to move a facet to a
    // new version is `facet add '<name>@<new-version>'`, which is what this runs.
    defineTool({
        name: "facet_update",
        title: "Update facet",
        description: "Move an installed facet to a specific version, updating facets.json and reinstalling it.",
        schema: updateArgs,
        shape: updateArgs.shape,
        annotations: MUTATES_ONLINE,
        output: "text",
        directoryMode: "cwd",
        argv: args => ["add", args.version === undefined ? args.name : `${args.name}@${args.version}`, ...projectFlags(args)],
    }),
    defineTool({
        name: "facet_install",
        title: "Install facets",
        description: "Restore a project from its lockfile, installing every facet facets.json declares at the versions already resolved.",
        schema: installArgs,
        shape: installArgs.shape,
        annotations: MUTATES_ONLINE,
        output: "text",
        directoryMode: "cwd",
        argv: args => ["install", ...(args.frozenLockfile === true ? ["--frozen-lockfile"] : []), ...projectFlags(args)],
    }),
    defineTool({
        name: "facet_remove",
        title: "Remove facet",
        description: "Remove a facet from the project and uninstall its assets.",
        schema: removeArgs,
        shape: removeArgs.shape,
        annotations: MUTATES,
        output: "text",
        directoryMode: "cwd",
        argv: args => ["remove", args.name, ...projectFlags(args)],
    }),
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Runs one tool end to end: validate, resolve the directory, spawn, interpret. */
export async function runTool(
    spec: ToolSpec,
    rawArgs: unknown,
    context: { projectRoot: string; runCli: RunCli; root?: ProjectRoot; supportsUi?: boolean },
): Promise<CallToolResult> {
    // Commands that take the directory as an argument still run at the root, so
    // both branches end up with a path that went through the containment check.
    const root = resolveDirectory(context.projectRoot, ".");
    const rootPath = root.ok ? root.path : path.resolve(context.projectRoot);

    // Every exit below goes through here, so no result can leave without the
    // summary the panel needs. Before a directory argument has been checked the
    // root stands in for it, which only ever affects what the card calls the
    // facet when the CLI didn't say.
    const render = (outcome: ToolOutcome, directory: string = rootPath): CallToolResult =>
        renderOutcome(outcome, {
            operation: spec.title,
            directory,
            ...(context.supportsUi === undefined ? {} : { supportsUi: context.supportsUi }),
        });

    const parsed = spec.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        return render(fail("invalid_input", describeIssues(parsed.error)));
    }

    const args = parsed.data as { directory?: string };
    const directory = resolveDirectory(context.projectRoot, args.directory);
    if (!directory.ok) {
        return render(fail("invalid_input", directory.message));
    }

    // A tool that reports absence has to be sure it looked in the right place.
    // When nobody told us where the project is, an empty list would read as
    // "this project has no facets" — a confident falsehood about a directory
    // the user never named. Saying so is the only honest answer.
    //
    // An explicit `directory` counts as being told, and a facets.json means the
    // fallback landed somewhere real, so neither case is stopped.
    if (
        spec.reportsAbsence === true &&
        args.directory === undefined &&
        context.root?.confirmed === false &&
        !existsSync(path.join(directory.path, "facets.json"))
    ) {
        return render(fail("no_project_root", unconfirmedRootMessage(context.root)), directory.path);
    }

    // The CLI is given the resolved path, never the label the caller wrote, so
    // it can't take a second and different reading of the same argument.
    const argv = spec.argv(parsed.data as never, directory.path);
    const offending = argv.find(part => CONTROL_CHARS.test(part));
    if (offending !== undefined) {
        // Belt and braces: nothing validated above can reach here.
        return render(fail("invalid_input", "arguments must not contain control characters"), directory.path);
    }

    // Last thing before the spawn: is that directory still the one we approved?
    const settled = reconfirmDirectory(context.projectRoot, directory.path);
    if (!settled.ok) {
        return render(fail("invalid_input", settled.message), directory.path);
    }

    const cwd = spec.directoryMode === "cwd" ? directory.path : rootPath;
    const result = await context.runCli({ argv, cwd });
    return render(interpret(result, spec.output), directory.path);
}

function describeIssues(error: z.ZodError): string {
    return error.issues
        .map(issue => {
            const where = issue.path.join(".");
            return where.length > 0 ? `${where}: ${issue.message}` : issue.message;
        })
        .join("; ");
}

/**
 * Registers all nine tools.
 *
 * A host that negotiated the UI extension gets App tools carrying the panel's
 * resource URI; a host that didn't gets the same tools without the UI metadata,
 * since pointing a text-only host at a panel it will never render is just noise.
 * The content is byte-identical either way.
 */
export function registerTools(server: Pick<McpServer, "registerTool">, deps: ToolDeps = {}): void {
    // Read per call, not captured here: the client can open a different folder
    // after registration, and the tools have to follow it.
    const readRoot = rootReader(deps);
    const runCli = deps.runCli ?? createCliRunner(deps.facetBin ?? "facet", deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    for (const spec of TOOL_SPECS) {
        const config = {
            title: spec.title,
            description: spec.description,
            inputSchema: spec.shape,
            annotations: spec.annotations,
        };
        const handler = (rawArgs: unknown): Promise<CallToolResult> =>
            runTool(spec, rawArgs, {
                projectRoot: readRoot().path,
                runCli,
                root: readRoot(),
                ...(deps.supportsUi === undefined ? {} : { supportsUi: deps.supportsUi }),
            });

        if (deps.supportsUi === true) {
            registerAppTool(server, spec.name, { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } }, handler as never);
        } else {
            server.registerTool(spec.name, config, handler as never);
        }
    }
}
