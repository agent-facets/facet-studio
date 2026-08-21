// The defect, end to end: a host that starts the server outside the project.
//
// Everything here runs a real server against a real client over the SDK's
// in-memory transports, with the working directory deliberately pointed at a
// scratch folder — the situation Claude Desktop and Cowork put the plugin in.
// The question each test asks is whether the server finds the user's project
// anyway, and whether it owns up when it cannot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "./server.js";

/** A project with facets declared in it, and a scratch dir that has none. */
interface Fixture {
    project: string;
    scratch: string;
}

let fixture: Fixture;
let enteredFrom: string;
const savedEnv: Record<string, string | undefined> = {};

function makeProject(root: string, facets: Record<string, string>): string {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "facets.json"), JSON.stringify({ facets, manifestVersion: 0.1 }, null, 2));
    return realpathSync(root);
}

beforeEach(() => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "facet-roots-")));
    fixture = {
        project: makeProject(path.join(base, "project"), {
            "viper-plans": "1.2.1",
            cowsay: "1.0.1",
            graphite: "0.1.0",
            worktrunk: "0.1.0",
            openspec: "0.1.0",
            "facet-meta": "latest",
            "@agentfacets/betterstack": "1.0.2",
            "@agentfacets/openspec-adversary": "3.2.2",
        }),
        scratch: makeScratch(path.join(base, "outputs")),
    };

    // The host's choice of working directory, not the user's.
    enteredFrom = process.cwd();
    process.chdir(fixture.scratch);

    for (const name of ["FACET_PROJECT_ROOT", "CLAUDE_PROJECT_DIR"]) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
    }
});

afterEach(() => {
    process.chdir(enteredFrom);
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(path.dirname(fixture.project), { recursive: true, force: true });
});

function makeScratch(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
}

/** A client that advertises the folders a host has open. */
async function connectWithRoots(roots: string[] | undefined): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = createServer();
    const client = new Client(
        { name: "roots-host", version: "0.0.0" },
        { capabilities: roots === undefined ? {} : { roots: { listChanged: true } } },
    );
    if (roots !== undefined) {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
            roots: roots.map(dir => ({ uri: `file://${dir}`, name: path.basename(dir) })),
        }));
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The roots request goes out right after the handshake; give it its turn.
    await new Promise(resolve => setTimeout(resolve, 50));

    return { client, close: async () => { await client.close(); await server.close(); } };
}

function textOf(result: CallToolResult): string {
    return (result.content as { text?: string }[]).map(part => part.text ?? "").join("\n");
}

describe("a host that starts the server outside the project", () => {
    test("the client's open folder is read, not the working directory", async () => {
        const { client, close } = await connectWithRoots([fixture.project]);
        try {
            const result = (await client.callTool({ name: "facet_project", arguments: {} })) as CallToolResult;
            const data = result.structuredContent as { directory: string; declared: boolean; facets: unknown[] };

            expect(data.directory).toBe(fixture.project);
            expect(data.declared).toBe(true);
            expect(data.facets).toHaveLength(8);
        } finally {
            await close();
        }
    });

    test("with no roots on offer, the answer says so instead of reporting an empty project", async () => {
        const { client, close } = await connectWithRoots(undefined);
        try {
            const result = (await client.callTool({ name: "facet_project", arguments: {} })) as CallToolResult;

            // The old behaviour returned declared:false with an empty list,
            // which reads as a fact about the user's project.
            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain("No workspace root was supplied");
            expect(textOf(result)).toContain(fixture.scratch);
        } finally {
            await close();
        }
    });

    test("several open folders: the one holding a project wins", async () => {
        const empty = makeScratch(path.join(path.dirname(fixture.project), "unrelated"));
        const { client, close } = await connectWithRoots([empty, fixture.project]);
        try {
            const result = (await client.callTool({ name: "facet_project", arguments: {} })) as CallToolResult;
            const data = result.structuredContent as { directory: string; facets: unknown[] };

            expect(data.directory).toBe(fixture.project);
            expect(data.facets).toHaveLength(8);
        } finally {
            await close();
        }
    });

    test("containment still refuses a directory outside the resolved root", async () => {
        const { client, close } = await connectWithRoots([fixture.project]);
        try {
            const result = (await client.callTool({
                name: "facet_project",
                arguments: { directory: "../outputs" },
            })) as CallToolResult;

            // The guard was never the bug — it was guarding the wrong root.
            // Fixing the root must not have loosened it.
            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain("resolves outside the project root");
        } finally {
            await close();
        }
    });

    test("a host that points CLAUDE_PROJECT_DIR at its own scratch dir still gets a true answer", async () => {
        // The live-Cowork hypothesis: the env branch is satisfied, so the root
        // counts as confirmed and the unconfirmed-root message never fires. The
        // answer must still name the directory it read and what pointed there,
        // rather than reporting an empty project as a fact.
        process.env.CLAUDE_PROJECT_DIR = fixture.scratch;
        const { client, close } = await connectWithRoots(undefined);
        try {
            const result = (await client.callTool({ name: "facet_project", arguments: {} })) as CallToolResult;
            const text = textOf(result);

            expect(text).toContain(fixture.scratch);
            expect(text).toContain("CLAUDE_PROJECT_DIR");
            expect(text).toContain("FACET_PROJECT_ROOT");
        } finally {
            await close();
        }
    });

    test("facet_capabilities reports the surface and the root, for an agent that cannot see either", async () => {
        // The channel that survives a host which captures no stderr and bridges
        // only tools. Everything a skill needs to branch on, in one call.
        const { client, close } = await connectWithRoots([fixture.project]);
        try {
            const result = (await client.callTool({ name: "facet_capabilities", arguments: {} })) as CallToolResult;
            const data = result.structuredContent as Record<string, unknown>;

            expect(data.tier).toBe("text");
            expect(data.consoleAvailable).toBe(false);
            expect(data.rootsAdvertised).toBe(true);
            expect(data.projectRoot).toBe(fixture.project);
            expect(data.rootVia).toBe("roots/list");
            expect(data.rootConfirmed).toBe(true);
            expect(data.projectFound).toBe(true);
        } finally {
            await close();
        }
    });

    test("facet_capabilities admits when the root is a guess and holds no project", async () => {
        const { client, close } = await connectWithRoots(undefined);
        try {
            const result = (await client.callTool({ name: "facet_capabilities", arguments: {} })) as CallToolResult;
            const data = result.structuredContent as Record<string, unknown>;

            expect(data.rootVia).toBe("cwd");
            expect(data.rootConfirmed).toBe(false);
            expect(data.projectFound).toBe(false);

            // Looking for facets is not a question about the current
            // directory. A missing project must never read as "degraded" —
            // the registry is reachable from anywhere.
            expect(data.registryAvailable).toBe(true);
            const text = textOf(result);
            expect(text).toContain("Registry: available");
            expect(text.indexOf("Registry: available")).toBeLessThan(text.indexOf("Project: none"));
            expect(text).toContain("Everything else is unaffected");
        } finally {
            await close();
        }
    });

    test("an environment root is honoured with no client roots at all", async () => {
        process.env.FACET_PROJECT_ROOT = fixture.project;
        const { client, close } = await connectWithRoots(undefined);
        try {
            const result = (await client.callTool({ name: "facet_project", arguments: {} })) as CallToolResult;
            const data = result.structuredContent as { directory: string; facets: unknown[] };

            expect(data.directory).toBe(fixture.project);
            expect(data.facets).toHaveLength(8);
        } finally {
            await close();
        }
    });
});
