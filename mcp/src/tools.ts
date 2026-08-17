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
// symlinks included.

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
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

const directoryField = directorySchema.optional().describe("Directory inside the project root. Defaults to the root itself.");
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
    });

const addArgs = z.object({
    name: facetNameSchema.describe("Facet to add, by registry name."),
    version: versionSchema.optional().describe("Version or range. Defaults to the latest release."),
    verbose: verboseField,
    acceptMcp: acceptMcpField,
    directory: directoryField,
});

// Moving a facet to a new version needs both halves of the coordinate, so unlike
// `facet_add` neither field is optional here: "update" with no version would just
// be an add, and "update" with no name would be an install.
const updateArgs = z.object({
    name: facetNameSchema.describe("Installed facet to move, by registry name."),
    version: versionSchema.describe("Version or range to move it to."),
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

export type ToolErrorCode = "invalid_input" | "cli_not_found" | "timeout" | "cli_failed" | "unreadable_output";

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

/**
 * Renders an outcome as tool content. This is the whole payload: a host with no
 * panel sees exactly what a host with one sees.
 */
export function renderOutcome(outcome: ToolOutcome): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        ...(outcome.ok ? {} : { isError: true }),
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

/**
 * Resolves a directory argument under the project root, refusing anything that
 * lands outside it.
 *
 * The path may not exist yet (that's the normal case for `facet create`), so we
 * resolve the deepest part that does exist through its symlinks and rebuild the
 * rest on top. That way a symlinked subdirectory pointing at /etc is caught,
 * not just a literal `../..`.
 */
export function resolveDirectory(projectRoot: string, directory: string | undefined): DirectoryResolution {
    const root = realpathish(path.resolve(projectRoot));
    const target = realpathish(path.resolve(root, directory ?? "."));
    if (target !== root && !target.startsWith(root + path.sep)) {
        return { ok: false, message: `directory "${directory ?? "."}" resolves outside the project root` };
    }
    return { ok: true, path: target };
}

/** `realpath` for a path that may not exist yet: resolve what does, keep the rest. */
function realpathish(target: string): string {
    const missing: string[] = [];
    let current = target;
    for (;;) {
        try {
            return path.join(realpathSync(current), ...missing.reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) {
                return target;
            }
            missing.push(path.basename(current));
            current = parent;
        }
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
        description: "List the facets a project declares, with their resolved versions.",
        schema: listArgs,
        shape: listArgs.shape,
        annotations: READ_ONLY,
        output: "text",
        directoryMode: "cwd",
        argv: () => ["list"],
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
            ...(args.private === undefined ? [] : ["--private"]),
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
        argv: args => ["add", `${args.name}@${args.version}`, ...projectFlags(args)],
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
export async function runTool(spec: ToolSpec, rawArgs: unknown, context: { projectRoot: string; runCli: RunCli }): Promise<CallToolResult> {
    const parsed = spec.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        return renderOutcome(fail("invalid_input", describeIssues(parsed.error)));
    }

    const args = parsed.data as { directory?: string };
    const directory = resolveDirectory(context.projectRoot, args.directory);
    if (!directory.ok) {
        return renderOutcome(fail("invalid_input", directory.message));
    }

    const argv = spec.argv(parsed.data as never, directory.path);
    const offending = argv.find(part => CONTROL_CHARS.test(part));
    if (offending !== undefined) {
        // Belt and braces: nothing validated above can reach here.
        return renderOutcome(fail("invalid_input", "arguments must not contain control characters"));
    }

    // Commands that take the directory as an argument still run at the root, so
    // both branches end up with a path that went through the containment check.
    const root = resolveDirectory(context.projectRoot, ".");
    const cwd = spec.directoryMode === "cwd" ? directory.path : root.ok ? root.path : path.resolve(context.projectRoot);
    const result = await context.runCli({ argv, cwd });
    return renderOutcome(interpret(result, spec.output));
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
    const projectRoot = path.resolve(deps.projectRoot ?? process.cwd());
    const runCli = deps.runCli ?? createCliRunner(deps.facetBin ?? "facet", deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    for (const spec of TOOL_SPECS) {
        const config = {
            title: spec.title,
            description: spec.description,
            inputSchema: spec.shape,
            annotations: spec.annotations,
        };
        const handler = (rawArgs: unknown): Promise<CallToolResult> => runTool(spec, rawArgs, { projectRoot, runCli });

        if (deps.supportsUi === true) {
            registerAppTool(server, spec.name, { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } }, handler as never);
        } else {
            server.registerTool(spec.name, config, handler as never);
        }
    }
}
