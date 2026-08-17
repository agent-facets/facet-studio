import { afterAll, describe, expect, test } from "bun:test";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
