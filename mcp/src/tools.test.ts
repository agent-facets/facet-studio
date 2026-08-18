import { afterAll, describe, expect, test } from "bun:test";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "./server.js";
import {
    assetNameSchema,
    createCliRunner,
    descriptionSchema,
    directorySchema,
    facetNameSchema,
    PANEL_RESOURCE_URI,
    registerTools,
    resolveDirectory,
    runTool,
    TOOL_SPECS,
    versionSchema,
    type CliInvocation,
    type CliResult,
    type RunCli,
    type ToolDeps,
} from "./tools.js";

const UI_CAPABLE: ClientCapabilities = { extensions: { [EXTENSION_ID]: {} } };
const TEXT_ONLY: ClientCapabilities = {};

const TOOL_NAMES = ["facet_list", "facet_verify", "facet_build", "facet_create", "facet_modify", "facet_add", "facet_update", "facet_install", "facet_remove"];

/** Temp directories this file made, cleaned up at the end of the run. */
const scratchDirs: string[] = [];

function scratch(): string {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "facet-studio-tools-")));
    scratchDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of scratchDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A spawn seam that records what it was asked to run and answers with canned output. */
function stubRunner(result: Partial<CliResult> = {}): { runCli: RunCli; calls: CliInvocation[] } {
    const calls: CliInvocation[] = [];
    const runCli: RunCli = invocation => {
        calls.push(invocation);
        return Promise.resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: "", ...result });
    };
    return { runCli, calls };
}

interface Harness {
    client: Client;
    calls: CliInvocation[];
    close: () => Promise<void>;
}

/** A real client talking to a real server over the SDK's in-memory transports. */
async function connect(options: { capabilities?: ClientCapabilities; projectRoot?: string; runCli?: RunCli; cliResult?: Partial<CliResult> } = {}): Promise<Harness> {
    const stub = stubRunner(options.cliResult);
    const runCli = options.runCli ?? stub.runCli;
    const projectRoot = options.projectRoot ?? scratch();

    const server = createServer({
        registerAll: (target, deps) => {
            registerTools(target, { ...deps, projectRoot, runCli });
        },
    });
    const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: options.capabilities ?? UI_CAPABLE });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
        client,
        calls: stub.calls,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

/** Pulls the `{ok, data|error}` payload back out of a tool result. */
function payload(result: unknown): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    return JSON.parse(content[0]?.text ?? "");
}

/** Pulls out the summary the panel draws its card from. */
function summary(result: unknown): Record<string, unknown> {
    const value = (result as { structuredContent?: unknown }).structuredContent;
    expect(value).toBeDefined();
    return value as Record<string, unknown>;
}

/**
 * Asserts a call was turned away by the published input schema — before the
 * handler ran, and so before anything could be spawned. The SDK reports schema
 * violations as an error result rather than a rejection, hence the shape here.
 */
async function expectSchemaRefusal(harness: Harness, name: string, args: Record<string, unknown>): Promise<void> {
    const result = await harness.client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("Invalid arguments");
    expect(harness.calls).toHaveLength(0);
}

/** Captures registrations without standing up a transport. */
function captureRegistrations(deps: ToolDeps): { name: string; config: Record<string, unknown> }[] {
    const captured: { name: string; config: Record<string, unknown> }[] = [];
    const fake = {
        registerTool: (name: string, config: Record<string, unknown>) => {
            captured.push({ name, config });
            return { remove: () => {}, enable: () => {}, disable: () => {}, update: () => {} };
        },
    };
    registerTools(fake as never, deps);
    return captured;
}

describe("schemas reject hostile input", () => {
    const hostileNames = [
        "; rm -rf ~",
        "--force",
        "-f",
        "../outside",
        "foo; touch /tmp/pwned",
        "foo bar",
        "$(whoami)",
        "`id`",
        "foo|bar",
        "foo\\bar",
        "Foo",
        "",
        "@scope/",
        "a".repeat(65),
        `@${"s".repeat(65)}/name`,
    ];

    for (const value of hostileNames) {
        test(`facet name ${JSON.stringify(value)} is rejected`, () => {
            expect(facetNameSchema.safeParse(value).success).toBe(false);
        });
    }

    for (const value of ["my-facet", "facet2", "@scope/my-facet", "a", "a".repeat(64)]) {
        test(`facet name ${JSON.stringify(value)} is accepted`, () => {
            expect(facetNameSchema.safeParse(value).success).toBe(true);
        });
    }

    test("asset names are never scoped and never flags", () => {
        expect(assetNameSchema.safeParse("demo").success).toBe(true);
        expect(assetNameSchema.safeParse("@scope/demo").success).toBe(false);
        expect(assetNameSchema.safeParse("--add").success).toBe(false);
        expect(assetNameSchema.safeParse("a".repeat(65)).success).toBe(false);
    });

    test("versions follow the registry's grammar", () => {
        for (const good of ["1.2.3", "0.0.0", "*", "1.x", "2.0.0-beta.1"]) {
            expect(versionSchema.safeParse(good).success).toBe(true);
        }
        for (const bad of ["-1", "v1", "; rm -rf ~", "--force", "$(id)", "1 2"]) {
            expect(versionSchema.safeParse(bad).success).toBe(false);
        }
    });

    test("free text may not pose as a flag or smuggle control characters", () => {
        expect(descriptionSchema.safeParse("A perfectly ordinary description.").success).toBe(true);
        expect(descriptionSchema.safeParse("--force").success).toBe(false);
        expect(descriptionSchema.safeParse("-x").success).toBe(false);
        expect(descriptionSchema.safeParse("line\nbreak").success).toBe(false);
        expect(descriptionSchema.safeParse("nul\u0000byte").success).toBe(false);
        expect(descriptionSchema.safeParse("").success).toBe(false);
    });

    test("directory strings may not pose as a flag", () => {
        expect(directorySchema.safeParse("packages/thing").success).toBe(true);
        expect(directorySchema.safeParse("--cwd").success).toBe(false);
        expect(directorySchema.safeParse("a\u0000b").success).toBe(false);
    });
});

describe("directory containment", () => {
    const root = scratch();
    mkdirSync(path.join(root, "nested", "deep"), { recursive: true });

    test("plain paths under the root resolve to absolute paths", () => {
        expect(resolveDirectory(root, undefined)).toEqual({ ok: true, path: root });
        expect(resolveDirectory(root, ".")).toEqual({ ok: true, path: root });
        expect(resolveDirectory(root, "nested/deep")).toEqual({ ok: true, path: path.join(root, "nested", "deep") });
        // Traversal that comes back inside is fine — containment is about where
        // you land, not how you got there.
        expect(resolveDirectory(root, "nested/../nested/deep")).toEqual({ ok: true, path: path.join(root, "nested", "deep") });
    });

    test("paths that escape the root are refused", () => {
        for (const escape of ["../outside", "../../..", "nested/../../elsewhere", "/etc", path.join(root, "..", "sibling")]) {
            const resolution = resolveDirectory(root, escape);
            expect(resolution.ok).toBe(false);
            expect(resolution.ok === false && resolution.message).toContain("outside the project root");
        }
    });

    test("a directory that does not exist yet still resolves, for facet_create", () => {
        expect(resolveDirectory(root, "brand-new/child")).toEqual({ ok: true, path: path.join(root, "brand-new", "child") });
    });

    test("a symlink pointing out of the root is refused", () => {
        const outside = scratch();
        symlinkSync(outside, path.join(root, "escape-hatch"));
        const resolution = resolveDirectory(root, "escape-hatch");
        expect(resolution.ok).toBe(false);
    });

    test("a sibling directory with the root as a name prefix is refused", () => {
        const resolution = resolveDirectory(root, `../${path.basename(root)}-evil`);
        expect(resolution.ok).toBe(false);
    });

    // The three below are all the same worry: a segment that isn't there yet is a
    // segment somebody else can create, and if we approve the path anyway we have
    // approved wherever they choose to point it.

    test("a project root that does not exist yet is refused, not assumed", () => {
        // Nothing between here and the filesystem root belongs to us, so the
        // deepest thing that actually exists sits *above* the root we are meant
        // to be confined to — the ideal spot to drop a symlink before the CLI runs.
        const resolution = resolveDirectory(path.join(root, "not-created-yet"), "child");
        expect(resolution.ok).toBe(false);
    });

    test("a dangling symlink is refused instead of passing as a fresh directory", () => {
        symlinkSync(path.join(scratch(), "gone"), path.join(root, "dangling"));
        const resolution = resolveDirectory(root, "dangling");
        expect(resolution.ok).toBe(false);
        expect(resolution.ok === false && resolution.message).toContain("does not lead anywhere");
    });

    test("a symlink loop is refused instead of being walked past", () => {
        const loop = path.join(root, "loop");
        symlinkSync(loop, loop);
        const resolution = resolveDirectory(root, "loop");
        expect(resolution.ok).toBe(false);
    });
});

describe("registration", () => {
    test("registers all nine tools, in order", async () => {
        const harness = await connect();
        try {
            const listed = await harness.client.listTools();
            expect(listed.tools.map(tool => tool.name)).toEqual(TOOL_NAMES);
        } finally {
            await harness.close();
        }
    });

    test("annotations mark read-only tools read-only and mutating tools destructive", async () => {
        const harness = await connect();
        try {
            const listed = await harness.client.listTools();
            const byName = new Map(listed.tools.map(tool => [tool.name, tool]));

            for (const name of ["facet_list", "facet_verify"]) {
                expect(byName.get(name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
            }
            for (const name of ["facet_build", "facet_create", "facet_modify", "facet_add", "facet_update", "facet_install", "facet_remove"]) {
                expect(byName.get(name)?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
            }
            // Only the three tools that talk to the registry are open-world.
            expect(byName.get("facet_add")?.annotations?.openWorldHint).toBe(true);
            expect(byName.get("facet_update")?.annotations?.openWorldHint).toBe(true);
            expect(byName.get("facet_install")?.annotations?.openWorldHint).toBe(true);
            expect(byName.get("facet_build")?.annotations?.openWorldHint).toBe(false);
        } finally {
            await harness.close();
        }
    });

    test("a ui-capable host gets the panel resource link on every tool", async () => {
        const harness = await connect({ capabilities: UI_CAPABLE });
        try {
            const listed = await harness.client.listTools();
            expect(listed.tools).toHaveLength(TOOL_NAMES.length);
            for (const tool of listed.tools) {
                expect((tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(PANEL_RESOURCE_URI);
            }
            expect(PANEL_RESOURCE_URI).toBe("ui://facet-studio/panel.html");
        } finally {
            await harness.close();
        }
    });

    test("a text-only host gets the same tools without a dangling panel link", async () => {
        const harness = await connect({ capabilities: TEXT_ONLY });
        try {
            const listed = await harness.client.listTools();
            expect(listed.tools.map(tool => tool.name)).toEqual(TOOL_NAMES);
            for (const tool of listed.tools) {
                expect((tool._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
            }
        } finally {
            await harness.close();
        }
    });

    test("content is identical with and without the panel", async () => {
        const projectRoot = scratch();
        const stdout = '{"schemaVersion":"2","ok":true,"verified":true}';
        const withPanel = await connect({ capabilities: UI_CAPABLE, projectRoot, cliResult: { stdout } });
        const withoutPanel = await connect({ capabilities: TEXT_ONLY, projectRoot, cliResult: { stdout } });
        try {
            const a = await withPanel.client.callTool({ name: "facet_verify", arguments: {} });
            const b = await withoutPanel.client.callTool({ name: "facet_verify", arguments: {} });
            expect(a.content).toEqual(b.content);
            expect(payload(a).ok).toBe(true);
        } finally {
            await withPanel.close();
            await withoutPanel.close();
        }
    });

    test("the ui metadata carries the legacy key too, for older hosts", () => {
        const registrations = captureRegistrations({ supportsUi: true, projectRoot: scratch(), runCli: stubRunner().runCli });
        expect(registrations.map(entry => entry.name)).toEqual(TOOL_NAMES);
        for (const entry of registrations) {
            expect(entry.config._meta).toMatchObject({ ui: { resourceUri: PANEL_RESOURCE_URI } });
        }
    });
});

describe("argv construction", () => {
    async function argvFor(name: string, args: Record<string, unknown>, projectRoot?: string): Promise<CliInvocation> {
        const harness = await connect({ projectRoot });
        try {
            const result = await harness.client.callTool({ name, arguments: args });
            expect(payload(result).ok).toBe(true);
            expect(harness.calls).toHaveLength(1);
            return harness.calls[0] as CliInvocation;
        } finally {
            await harness.close();
        }
    }

    test("facet_list runs plain, inside the requested directory", async () => {
        const root = scratch();
        mkdirSync(path.join(root, "project"));
        const call = await argvFor("facet_list", { directory: "project" }, root);
        expect(call.argv).toEqual(["list"]);
        expect(call.cwd).toBe(path.join(root, "project"));
    });

    test("facet_verify asks for --verify --json and passes the directory positionally", async () => {
        const root = scratch();
        const call = await argvFor("facet_verify", {}, root);
        expect(call.argv).toEqual(["build", "--verify", "--json", root]);
        expect(call.cwd).toBe(root);
    });

    test("facet_build adds --emit-manifest only when asked", async () => {
        const root = scratch();
        expect((await argvFor("facet_build", {}, root)).argv).toEqual(["build", "--json", root]);
        expect((await argvFor("facet_build", { emitManifest: true }, root)).argv).toEqual(["build", "--json", "--emit-manifest", root]);
    });

    test("facet_create spells every option out as its own argv element", async () => {
        const root = scratch();
        const call = await argvFor(
            "facet_create",
            {
                name: "@scope/my-facet",
                description: "A facet for testing.",
                version: "1.2.3",
                private: true,
                skills: ["alpha", "beta"],
                agents: ["gamma"],
                commands: ["delta"],
                readme: false,
                force: true,
                directory: "new-thing",
            },
            root,
        );
        expect(call.argv).toEqual([
            "create",
            "--json",
            "--name",
            "@scope/my-facet",
            "--description",
            "A facet for testing.",
            "--version",
            "1.2.3",
            "--private",
            "--skill",
            "alpha",
            "--skill",
            "beta",
            "--agent",
            "gamma",
            "--command",
            "delta",
            "--no-readme",
            "--force",
            path.join(root, "new-thing"),
        ]);
        // The directory the CLI acts on is an argument, so the child runs at the root.
        expect(call.cwd).toBe(root);
    });

    test("facet_modify puts the asset name before the flags and the directory last", async () => {
        const root = scratch();
        const call = await argvFor("facet_modify", { target: "skill", name: "demo", add: true, description: "A demo skill." }, root);
        expect(call.argv).toEqual(["modify", "skill", "demo", "--add", "--description", "A demo skill.", "--json", root]);
    });

    test("facet_modify on the facet itself takes no asset name", async () => {
        const root = scratch();
        const call = await argvFor("facet_modify", { target: "facet", facetName: "renamed", version: "2.0.0" }, root);
        expect(call.argv).toEqual(["modify", "facet", "--name", "renamed", "--version", "2.0.0", "--json", root]);
    });

    test("facet_modify asks for --private only when the answer is yes", async () => {
        const root = scratch();
        const call = await argvFor("facet_modify", { target: "facet", private: true }, root);
        expect(call.argv).toEqual(["modify", "facet", "--private", "--json", root]);

        // And with no opinion at all, the flag is simply absent.
        const untouched = await argvFor("facet_modify", { target: "facet", version: "2.0.0" }, root);
        expect(untouched.argv).not.toContain("--private");
    });

    test("facet_add joins name and version into one argv element", async () => {
        const root = scratch();
        expect((await argvFor("facet_add", { name: "@scope/thing", version: "1.2.3" }, root)).argv).toEqual(["add", "@scope/thing@1.2.3"]);
        expect((await argvFor("facet_add", { name: "thing", verbose: true, acceptMcp: true }, root)).argv).toEqual(["add", "thing", "--verbose", "--accept-mcp"]);
    });

    test("facet_update moves one facet to one version, as a single argv element", async () => {
        const root = scratch();
        // The CLI has no `update` subcommand; `add name@version` is the documented move.
        expect((await argvFor("facet_update", { name: "my-facet", version: "2.0.0" }, root)).argv).toEqual(["add", "my-facet@2.0.0"]);
        expect((await argvFor("facet_update", { name: "@scope/thing", version: "2.*", verbose: true, acceptMcp: true }, root)).argv).toEqual([
            "add",
            "@scope/thing@2.*",
            "--verbose",
            "--accept-mcp",
        ]);
    });

    test("facet_install restores the project from its lockfile", async () => {
        const root = scratch();
        expect((await argvFor("facet_install", {}, root)).argv).toEqual(["install"]);
        expect((await argvFor("facet_install", { frozenLockfile: true, verbose: true }, root)).argv).toEqual(["install", "--frozen-lockfile", "--verbose"]);
        expect((await argvFor("facet_install", { acceptMcp: true }, root)).argv).toEqual(["install", "--accept-mcp"]);
    });

    test("facet_remove names exactly one facet", async () => {
        const root = scratch();
        expect((await argvFor("facet_remove", { name: "thing" }, root)).argv).toEqual(["remove", "thing"]);
    });

    test("no argv element is ever a joined command string", async () => {
        const root = scratch();
        const call = await argvFor("facet_create", { name: "my-facet", description: "Ordinary text." }, root);
        for (const element of call.argv) {
            expect(element).not.toContain(" && ");
            expect(element).not.toContain(";");
            expect(element).not.toContain("|");
        }
    });
});

describe("hostile calls never reach the CLI", () => {
    for (const name of ["; rm -rf ~", "--force", "../../etc/passwd", "$(id)"]) {
        test(`facet_create refuses the name ${JSON.stringify(name)}`, async () => {
            const harness = await connect();
            try {
                await expectSchemaRefusal(harness, "facet_create", { name });
            } finally {
                await harness.close();
            }
        });
    }

    test("facet_remove refuses a flag-shaped facet name", async () => {
        const harness = await connect();
        try {
            await expectSchemaRefusal(harness, "facet_remove", { name: "--force" });
        } finally {
            await harness.close();
        }
    });

    for (const version of ["--force", "; rm -rf ~", "v2", "$(id)", "2.0.0 --accept-mcp"]) {
        test(`facet_update refuses the version ${JSON.stringify(version)}`, async () => {
            const harness = await connect();
            try {
                await expectSchemaRefusal(harness, "facet_update", { name: "my-facet", version });
            } finally {
                await harness.close();
            }
        });
    }

    test("facet_update refuses a move with no version to move to", async () => {
        const harness = await connect();
        try {
            await expectSchemaRefusal(harness, "facet_update", { name: "my-facet" });
        } finally {
            await harness.close();
        }
    });

    test("facet_modify refuses a flag-shaped asset name", async () => {
        const harness = await connect();
        try {
            await expectSchemaRefusal(harness, "facet_modify", { target: "skill", name: "--remove" });
        } finally {
            await harness.close();
        }
    });

    test("a directory outside the project root is refused before spawning", async () => {
        const harness = await connect();
        try {
            const result = await harness.client.callTool({ name: "facet_verify", arguments: { directory: "../outside" } });
            const body = payload(result);
            expect(body.ok).toBe(false);
            expect(body.error?.code).toBe("invalid_input");
            expect(body.error?.message).toContain("outside the project root");
            expect(result.isError).toBe(true);
            expect(harness.calls).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });

    test("an absolute directory outside the project root is refused too", async () => {
        const harness = await connect();
        try {
            const result = await harness.client.callTool({ name: "facet_list", arguments: { directory: "/etc" } });
            expect(payload(result).error?.code).toBe("invalid_input");
            expect(harness.calls).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });

    test("facet_modify refuses an asset edit with no asset name", async () => {
        // Without this guard the CLI would read the directory as the asset name.
        const harness = await connect();
        try {
            const result = await harness.client.callTool({ name: "facet_modify", arguments: { target: "skill", description: "x" } });
            const body = payload(result);
            expect(body.ok).toBe(false);
            expect(body.error?.code).toBe("invalid_input");
            expect(body.error?.message).toContain("name is required");
            expect(harness.calls).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });

    test("asking for private:false is refused, never quietly inverted", async () => {
        // The CLI can set the private flag but has nothing that clears it, so the
        // old code sent `--private` for `private: false` and made the facet
        // private — the exact opposite of the request. Refusing is the only
        // honest answer available.
        const harness = await connect();
        try {
            const result = await harness.client.callTool({ name: "facet_modify", arguments: { target: "facet", private: false } });
            const body = payload(result);
            expect(body.ok).toBe(false);
            expect(body.error?.code).toBe("invalid_input");
            expect(body.error?.message).toContain("no operation to clear it");
            expect(harness.calls).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });

    test("facet_modify refuses facet-level flags on an asset target", async () => {
        const harness = await connect();
        try {
            const result = await harness.client.callTool({ name: "facet_modify", arguments: { target: "skill", name: "demo", version: "2.0.0" } });
            expect(payload(result).error?.message).toContain("only valid when target is 'facet'");
            expect(harness.calls).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });
});

describe("results", () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === "facet_verify");
    const textSpec = TOOL_SPECS.find(candidate => candidate.name === "facet_list");

    async function run(result: CliResult, which = spec): Promise<ReturnType<typeof payload>> {
        const projectRoot = scratch();
        const runCli: RunCli = () => Promise.resolve(result);
        return payload(await runTool(which as NonNullable<typeof spec>, {}, { projectRoot, runCli }));
    }

    test("a --json command returns its parsed payload as data", async () => {
        const body = await run({ exitCode: 0, stdout: '{"ok":true,"verified":true,"name":"probe"}', stderr: "" });
        expect(body).toEqual({ ok: true, data: { ok: true, verified: true, name: "probe" } });
    });

    test("a plain command returns its trimmed output", async () => {
        const body = await run({ exitCode: 0, stdout: "  No facets.json in this directory.\n", stderr: "" }, textSpec);
        expect(body).toEqual({ ok: true, data: { output: "No facets.json in this directory." } });
    });

    test("a non-zero exit becomes a cli_failed error carrying the CLI's own message", async () => {
        const body = await run({ exitCode: 1, stdout: "", stderr: "No facet.json found in .\n" });
        expect(body.ok).toBe(false);
        expect(body.error).toMatchObject({ code: "cli_failed", message: "No facet.json found in .", exitCode: 1 });
    });

    test("output that claims to be json but is not is reported, not swallowed", async () => {
        const body = await run({ exitCode: 0, stdout: "not json at all", stderr: "" });
        expect(body.error).toMatchObject({ code: "unreadable_output", stdout: "not json at all" });
    });

    test("a missing binary and a timeout are distinguishable", async () => {
        expect((await run({ exitCode: null, stdout: "", stderr: "spawn facet ENOENT", failure: "not-found" })).error?.code).toBe("cli_not_found");
        expect((await run({ exitCode: null, stdout: "", stderr: "killed", failure: "timeout" })).error?.code).toBe("timeout");
    });
});

describe("the summary the panel draws", () => {
    test("every one of the nine tools answers with one, not just some", async () => {
        const extraArgs: Record<string, Record<string, unknown>> = {
            facet_create: { name: "probe" },
            facet_modify: { target: "facet", version: "1.0.0" },
            facet_add: { name: "probe" },
            facet_update: { name: "probe", version: "1.0.0" },
            facet_remove: { name: "probe" },
        };
        const harness = await connect();
        try {
            for (const name of TOOL_NAMES) {
                const card = summary(await harness.client.callTool({ name, arguments: extraArgs[name] ?? {} }));
                expect(typeof card.facet).toBe("string");
                expect(card.facet).not.toBe("Unknown facet");
                expect(typeof card.operation).toBe("string");
                expect(["success", "error"]).toContain(card.status);
                expect(typeof card.message).toBe("string");
                expect(Array.isArray(card.assets)).toBe(true);
            }
        } finally {
            await harness.close();
        }
    });

    test("the facet is named by the CLI payload, and assets typed by where files live", async () => {
        const root = scratch();
        const stdout = JSON.stringify({
            ok: true,
            name: "probe-facet",
            files: ["facet.json", "skills/demo/SKILL.md", "agents/helper.md", "commands/go.md"],
        });
        const harness = await connect({ projectRoot: root, cliResult: { stdout } });
        try {
            const card = summary(await harness.client.callTool({ name: "facet_build", arguments: {} }));
            expect(card.facet).toBe("probe-facet");
            expect(card.operation).toBe("Build facet");
            expect(card.status).toBe("success");
            expect(card.assets).toEqual([
                { type: "file", name: "facet.json" },
                { type: "skill", name: "demo", detail: "skills/demo/SKILL.md" },
                { type: "agent", name: "helper", detail: "agents/helper.md" },
                { type: "command", name: "go", detail: "commands/go.md" },
            ]);
        } finally {
            await harness.close();
        }
    });

    test("when the payload has no name, the directory supplies one and the manifest stays shut", async () => {
        // `facet modify --json` reports only what it changed, so this is the case
        // that used to leave the card reading "Unknown facet" — and then, for a
        // while, reading facet.json to do better than that.
        const root = scratch();
        writeFileSync(
            path.join(root, "facet.json"),
            JSON.stringify({ name: "manifest-facet", skills: { demo: { description: "A demo skill." } } }),
        );
        const harness = await connect({ projectRoot: root, cliResult: { stdout: '{"ok":true,"changes":["set version to \\"1.0.0\\""]}' } });
        try {
            const card = summary(await harness.client.callTool({ name: "facet_modify", arguments: { target: "facet", version: "1.0.0" } }));
            expect(card.facet).toBe(path.basename(root));
            expect(card.facet).not.toBe("Unknown facet");
            expect(card.operation).toBe("Modify facet");
            expect(card.message).toBe('set version to "1.0.0"');
            // The modify reported a change, not a file, so there is nothing to table.
            expect(card.assets).toEqual([]);
        } finally {
            await harness.close();
        }
    });

    test("with no name anywhere, the directory names the facet", async () => {
        const root = scratch();
        const harness = await connect({ projectRoot: root, cliResult: { stdout: "No facets.json in this directory." } });
        try {
            const card = summary(await harness.client.callTool({ name: "facet_list", arguments: {} }));
            expect(card.facet).toBe(path.basename(root));
            expect(card.facet).not.toBe("Unknown facet");
            expect(card.message).toBe("No facets.json in this directory.");
        } finally {
            await harness.close();
        }
    });

    test("a failure shows the CLI's own sentence, not a dump of the error object", async () => {
        const root = scratch();
        const harness = await connect({
            projectRoot: root,
            cliResult: { exitCode: 1, stdout: "", stderr: "No facet.json found in .\n  fix: run 'facet create' first\n" },
        });
        try {
            const result = await harness.client.callTool({ name: "facet_verify", arguments: {} });
            const card = summary(result);
            expect(result.isError).toBe(true);
            expect(card.status).toBe("error");
            expect(card.message).toBe("No facet.json found in .");
            expect(card.message).not.toContain("{");
            expect(card.assets).toEqual([]);
            expect(card.facet).not.toBe("Unknown facet");
        } finally {
            await harness.close();
        }
    });

    test("a call rejected before anything spawns still gets a card", async () => {
        const harness = await connect();
        try {
            const card = summary(await harness.client.callTool({ name: "facet_verify", arguments: { directory: "../outside" } }));
            expect(card.status).toBe("error");
            expect(card.message).toContain("outside the project root");
            expect(card.facet).not.toBe("Unknown facet");
            expect(harness.calls).toHaveLength(0);
        } finally {
            await harness.close();
        }
    });

    test("the text part is still the whole envelope, byte for byte", async () => {
        // The summary is an addition, not a replacement: a host with no panel
        // must read exactly what it read before.
        const root = scratch();
        const harness = await connect({ projectRoot: root, cliResult: { stdout: '{"ok":true,"name":"probe","files":[]}' } });
        try {
            const result = await harness.client.callTool({ name: "facet_verify", arguments: {} });
            const content = result.content as { type: string; text: string }[];
            expect(content).toHaveLength(1);
            expect(content[0]?.text).toBe(JSON.stringify({ ok: true, data: { ok: true, name: "probe", files: [] } }, null, 2));
        } finally {
            await harness.close();
        }
    });
});

describe("the card reports the operation, never the manifest", () => {
    // A manifest that a hostile or merely private project could plausibly hold:
    // one line nobody outside the project should see, and one credential.
    const PRIVATE_LINE = "PRIVATE-ROADMAP-Q3 unreleased acquisition codename";
    const CREDENTIAL = "fct_pub_abcdefgh.ijklmnop12345678";

    /** A project root whose facet.json declares assets the CLI will not report. */
    function rootWithSecretManifest(): string {
        const root = scratch();
        writeFileSync(
            path.join(root, "facet.json"),
            JSON.stringify({
                name: "manifest-facet",
                skills: { "internal-notes": { description: `${PRIVATE_LINE} ${CREDENTIAL}` } },
                agents: { "internal-agent": { description: PRIVATE_LINE } },
                commands: { "internal-command": { description: PRIVATE_LINE } },
            }),
        );
        return root;
    }

    /** Everything a host can read off a result, as one string per channel. */
    function channels(result: unknown): { text: string; structured: string } {
        return {
            text: JSON.stringify((result as { content: unknown }).content),
            structured: JSON.stringify((result as { structuredContent: unknown }).structuredContent),
        };
    }

    test("a text-mode result carries the CLI's line and nothing from the manifest", async () => {
        // The reported leak, exactly: text mode returns `{output:"added"}`, so the
        // text channel holds one word — while the card used to carry every skill
        // description in facet.json, credential and all.
        const root = rootWithSecretManifest();
        const harness = await connect({ projectRoot: root, cliResult: { stdout: "added" } });
        try {
            const result = await harness.client.callTool({ name: "facet_add", arguments: { name: "probe" } });
            const { text, structured } = channels(result);
            expect(payload(result)).toEqual({ ok: true, data: { output: "added" } });

            expect(text).toContain("added");
            for (const channel of [text, structured]) {
                expect(channel).not.toContain(PRIVATE_LINE);
                expect(channel).not.toContain("fct_pub_");
                expect(channel).not.toContain("internal-notes");
            }
            expect(summary(result).assets).toEqual([]);
        } finally {
            await harness.close();
        }
    });

    test("facet_list shows no asset rows, because listing produces none", async () => {
        const root = rootWithSecretManifest();
        const harness = await connect({ projectRoot: root, cliResult: { stdout: "probe@1.0.0" } });
        try {
            const card = summary(await harness.client.callTool({ name: "facet_list", arguments: {} }));
            expect(card.assets).toEqual([]);
            expect(card.message).toBe("probe@1.0.0");
            // The name is the directory's, not the manifest's: a list operation
            // never read facet.json, so the card must not claim it did.
            expect(card.facet).toBe(path.basename(root));
            expect(card.facet).not.toBe("manifest-facet");
        } finally {
            await harness.close();
        }
    });

    test("a build still lists exactly the files it genuinely reported", async () => {
        // The other half of the rule: dropping the manifest must not cost us the
        // rows a command really did produce.
        const root = rootWithSecretManifest();
        const stdout = JSON.stringify({ ok: true, name: "probe-facet", files: ["skills/demo/SKILL.md", "dist/probe-facet.facet"] });
        const harness = await connect({ projectRoot: root, cliResult: { stdout } });
        try {
            const card = summary(await harness.client.callTool({ name: "facet_build", arguments: {} }));
            expect(card.facet).toBe("probe-facet");
            expect(card.assets).toEqual([
                { type: "skill", name: "demo", detail: "skills/demo/SKILL.md" },
                { type: "file", name: "dist/probe-facet.facet" },
            ]);
        } finally {
            await harness.close();
        }
    });

    test("a verify reports the assets it names, and no others", async () => {
        const root = rootWithSecretManifest();
        const stdout = JSON.stringify({ ok: true, verified: true, name: "probe-facet", files: ["agents/helper.md"] });
        const harness = await connect({ projectRoot: root, cliResult: { stdout } });
        try {
            const card = summary(await harness.client.callTool({ name: "facet_verify", arguments: {} }));
            expect(card.status).toBe("success");
            expect(card.assets).toEqual([{ type: "agent", name: "helper", detail: "agents/helper.md" }]);
        } finally {
            await harness.close();
        }
    });

    test("a credential in the CLI's own words is redacted in both channels alike", async () => {
        const root = scratch();
        const harness = await connect({
            projectRoot: root,
            cliResult: { exitCode: 1, stdout: "", stderr: `registry refused the token ${CREDENTIAL}\n` },
        });
        try {
            const result = await harness.client.callTool({ name: "facet_add", arguments: { name: "probe" } });
            const { text, structured } = channels(result);
            for (const channel of [text, structured]) {
                expect(channel).not.toContain("fct_pub_");
                expect(channel).toContain("[redacted]");
            }
            expect(summary(result).message).toBe("registry refused the token [redacted]");
        } finally {
            await harness.close();
        }
    });
});

describe("the directory is re-checked at the last moment", () => {
    const verifySpec = TOOL_SPECS.find(candidate => candidate.name === "facet_verify") as (typeof TOOL_SPECS)[number];

    test("the CLI is handed the resolved path, not the label it came from", async () => {
        // A symlink that stays inside the root is allowed — but what goes to the
        // CLI is where it lands, so nobody can repoint it after we approved it.
        const root = scratch();
        mkdirSync(path.join(root, "real"));
        symlinkSync(path.join(root, "real"), path.join(root, "link"));
        const harness = await connect({ projectRoot: root });
        try {
            await harness.client.callTool({ name: "facet_verify", arguments: { directory: "link" } });
            expect(harness.calls).toHaveLength(1);
            expect(harness.calls[0]?.argv).toEqual(["build", "--verify", "--json", path.join(root, "real")]);
        } finally {
            await harness.close();
        }
    });

    test("a directory swapped for an escaping symlink after the check is refused before the spawn", async () => {
        const root = scratch();
        const outside = scratch();
        const work = path.join(root, "work");
        mkdirSync(work);

        // Building the argv is the last thing that happens between the check and
        // the spawn, so it stands in for anything else that could run in that
        // window — here, an attacker replacing the approved directory.
        const calls: CliInvocation[] = [];
        const runCli: RunCli = invocation => {
            calls.push(invocation);
            return Promise.resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
        };
        const interposing = {
            ...verifySpec,
            argv: (args: never, dir: string) => {
                rmSync(work, { recursive: true, force: true });
                symlinkSync(outside, work);
                return verifySpec.argv(args, dir);
            },
        };

        const result = await runTool(interposing, { directory: "work" }, { projectRoot: root, runCli });
        const body = payload(result);
        expect(body.ok).toBe(false);
        expect(body.error?.code).toBe("invalid_input");
        expect(calls).toHaveLength(0);
        expect(result.isError).toBe(true);
    });

    test("a directory that is still what it was passes the second check", async () => {
        const root = scratch();
        mkdirSync(path.join(root, "steady"));
        const harness = await connect({ projectRoot: root });
        try {
            const result = await harness.client.callTool({ name: "facet_verify", arguments: { directory: "steady" } });
            expect(payload(result).ok).toBe(true);
            expect(harness.calls).toHaveLength(1);
        } finally {
            await harness.close();
        }
    });
});

describe("the real facet CLI", () => {
    test(
        "scaffolds and verifies a facet through the tools, spawning the actual binary",
        async () => {
            const projectRoot = scratch();
            const harness = await connect({ projectRoot, runCli: createCliRunner("facet", 60_000) });
            try {
                const created = payload(
                    await harness.client.callTool({
                        name: "facet_create",
                        arguments: { name: "probe-facet", description: "A facet built by the tools test.", skills: ["demo"] },
                    }),
                );
                expect(created.ok).toBe(true);
                expect(created.data).toMatchObject({ ok: true, name: "probe-facet" });

                const verified = payload(await harness.client.callTool({ name: "facet_verify", arguments: {} }));
                expect(verified.ok).toBe(true);
                expect(verified.data).toMatchObject({ ok: true, verified: true, name: "probe-facet" });
                expect((verified.data as { integrity: string }).integrity).toMatch(/^sha256:[0-9a-f]{64}$/);

                // And the failure path, live: an empty directory has nothing to verify.
                mkdirSync(path.join(projectRoot, "empty"));
                const missing = payload(await harness.client.callTool({ name: "facet_verify", arguments: { directory: "empty" } }));
                expect(missing.ok).toBe(false);
                expect(missing.error?.code).toBe("cli_failed");
            } finally {
                await harness.close();
            }
        },
        120_000,
    );

    test(
        "names the real facet on the card, through a live client and the real binary",
        async () => {
            const projectRoot = scratch();
            const harness = await connect({ projectRoot, runCli: createCliRunner("facet", 60_000) });
            try {
                const created = summary(
                    await harness.client.callTool({
                        name: "facet_create",
                        arguments: { name: "panel-probe", description: "A facet built by the tools test.", skills: ["demo"] },
                    }),
                );
                expect(created.facet).toBe("panel-probe");
                expect(created.assets).toContainEqual({ type: "skill", name: "demo", detail: "skills/demo/SKILL.md" });

                const verified = summary(await harness.client.callTool({ name: "facet_verify", arguments: {} }));
                expect(verified.facet).toBe("panel-probe");
                expect(verified.facet).not.toBe("Unknown facet");
                expect(verified.operation).toBe("Verify facet");
                expect(verified.status).toBe("success");

                // `facet list` prints prose and names nothing, and a real
                // facet.json is sitting right there — so this is the live check
                // that we still don't reach for it.
                const listed = summary(await harness.client.callTool({ name: "facet_list", arguments: {} }));
                expect(listed.facet).toBe(path.basename(projectRoot));
                expect(listed.facet).not.toBe("panel-probe");
                expect(listed.facet).not.toBe("Unknown facet");
                expect(listed.assets).toEqual([]);
            } finally {
                await harness.close();
            }
        },
        120_000,
    );

    test(
        "a hostile name is refused before the real binary is ever spawned",
        async () => {
            const projectRoot = scratch();
            const harness = await connect({ projectRoot, runCli: createCliRunner("facet", 60_000) });
            try {
                const refused = await harness.client.callTool({ name: "facet_create", arguments: { name: "; rm -rf ~" } });
                expect(refused.isError).toBe(true);
                expect((refused.content as { text: string }[])[0]?.text).toContain("Invalid arguments");
                // Nothing ran, so nothing was scaffolded on disk.
                expect(existsSync(path.join(projectRoot, "facet.json"))).toBe(false);
                expect(readdirSync(projectRoot)).toEqual([]);
            } finally {
                await harness.close();
            }
        },
        60_000,
    );
});
