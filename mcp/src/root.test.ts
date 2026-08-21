// Where the project is, and how sure we are about it.
//
// The bug these cover: the server used to take process.cwd() as the project,
// which in a desktop host is a session scratch directory. Every read then
// reported an empty project as fact. So the tests here are less about paths
// than about evidence — which source won, and whether the answer admits when
// nobody actually said.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
    ProjectRootHolder,
    chooseRoot,
    describeNegotiation,
    describeRoot,
    resolveRoot,
    resolveRootSync,
    rootReader,
    rootUriToPath,
    unconfirmedRootMessage,
} from "./root.js";

const uri = (dir: string): string => `file://${dir}`;
const never = (): boolean => false;

describe("precedence", () => {
    test("an explicit root beats everything else on offer", async () => {
        const root = await resolveRoot({
            projectRoot: "/explicit",
            env: { FACET_PROJECT_ROOT: "/from-env" },
            listRoots: async () => ({ roots: [{ uri: uri("/from-client") }] }),
            cwd: () => "/from-cwd",
        });
        expect(root.path).toBe(path.resolve("/explicit"));
        expect(root.source).toBe("explicit");
        expect(root.confirmed).toBe(true);
    });

    test("the environment beats the client and the cwd", async () => {
        const root = await resolveRoot({
            env: { FACET_PROJECT_ROOT: "/from-env" },
            listRoots: async () => ({ roots: [{ uri: uri("/from-client") }] }),
            cwd: () => "/from-cwd",
        });
        expect(root.path).toBe(path.resolve("/from-env"));
        expect(root.source).toBe("environment");
    });

    test("CLAUDE_PROJECT_DIR is honoured, so a host that sets it needs no config", async () => {
        const root = await resolveRoot({ env: { CLAUDE_PROJECT_DIR: "/host-project" }, cwd: () => "/from-cwd" });
        expect(root.path).toBe(path.resolve("/host-project"));
        expect(root.source).toBe("environment");
    });

    test("FACET_PROJECT_ROOT wins over CLAUDE_PROJECT_DIR when both are set", async () => {
        const root = await resolveRoot({
            env: { FACET_PROJECT_ROOT: "/explicit-env", CLAUDE_PROJECT_DIR: "/host-project" },
            cwd: () => "/from-cwd",
        });
        expect(root.path).toBe(path.resolve("/explicit-env"));
    });

    test("an empty environment value is not an answer", async () => {
        const root = await resolveRoot({ env: { FACET_PROJECT_ROOT: "   " }, cwd: () => "/from-cwd" });
        expect(root.source).toBe("working-directory");
    });

    test("the client's open folder beats the cwd", async () => {
        const root = await resolveRoot({
            env: {},
            listRoots: async () => ({ roots: [{ uri: uri("/workspace") }] }),
            cwd: () => "/from-cwd",
        });
        expect(root.path).toBe(path.resolve("/workspace"));
        expect(root.source).toBe("client-roots");
        expect(root.confirmed).toBe(true);
    });

    test("the cwd is the last resort, and is never called confirmed", async () => {
        const root = await resolveRoot({ env: {}, cwd: () => "/from-cwd" });
        expect(root.path).toBe(path.resolve("/from-cwd"));
        expect(root.source).toBe("working-directory");
        expect(root.confirmed).toBe(false);
    });

    test("a client that fails the roots request costs nothing but the round trip", async () => {
        const root = await resolveRoot({
            env: {},
            listRoots: async () => {
                throw new Error("client hung up");
            },
            cwd: () => "/from-cwd",
        });
        expect(root.source).toBe("working-directory");
    });
});

describe("more than one open folder", () => {
    test("the folder that holds a project wins, whatever order it came in", () => {
        const picked = chooseRoot(["/a", "/b", "/c"], dir => dir === "/b");
        expect(picked?.chosen).toBe("/b");
        expect(picked?.others).toEqual(["/a", "/c"]);
    });

    test("with no project among them, the first is taken and the rest are kept", () => {
        const picked = chooseRoot(["/a", "/b"], never);
        expect(picked?.chosen).toBe("/a");
        expect(picked?.others).toEqual(["/b"]);
    });

    test("the runners-up are reported, so the answer can say what else was open", async () => {
        const root = await resolveRoot({
            env: {},
            listRoots: async () => ({ roots: [{ uri: uri("/one") }, { uri: uri("/two") }] }),
            cwd: () => "/from-cwd",
        });
        expect(root.otherRoots).toEqual([path.resolve("/two")]);
        expect(describeRoot(root)).toContain("1 other folder open");
    });

    test("no folders at all is not an answer", () => {
        expect(chooseRoot([], never)).toBeUndefined();
    });

    test("a non-file URI is skipped rather than allowed to throw", async () => {
        const root = await resolveRoot({
            env: {},
            listRoots: async () => ({ roots: [{ uri: "https://example.test/repo" }, { uri: uri("/real") }] }),
            cwd: () => "/from-cwd",
        });
        expect(root.path).toBe(path.resolve("/real"));
    });

    test("rootUriToPath takes file URIs and refuses the rest", () => {
        expect(rootUriToPath("file:///tmp/x")).toBe(path.resolve("/tmp/x"));
        expect(rootUriToPath("https://example.test")).toBeUndefined();
        expect(rootUriToPath("not a uri at all")).toBeUndefined();
    });
});

describe("staying current", () => {
    test("a folder switch mid-session is picked up", async () => {
        let open = "/first";
        const holder = new ProjectRootHolder(resolveRootSync({ env: {}, cwd: () => "/from-cwd" }), {
            env: {},
            cwd: () => "/from-cwd",
            listRoots: async () => ({ roots: [{ uri: uri(open) }] }),
        });

        expect(holder.current().source).toBe("working-directory");
        await holder.refresh();
        expect(holder.current().path).toBe(path.resolve("/first"));

        open = "/second";
        await holder.refresh();
        expect(holder.current().path).toBe(path.resolve("/second"));
    });

    test("tools read through the holder, so they see the switch too", async () => {
        const holder = new ProjectRootHolder(resolveRootSync({ env: {}, cwd: () => "/start" }), {
            env: {},
            cwd: () => "/start",
            listRoots: async () => ({ roots: [{ uri: uri("/moved") }] }),
        });
        const read = rootReader({ rootHolder: holder });

        expect(read().path).toBe(path.resolve("/start"));
        await holder.refresh();
        expect(read().path).toBe(path.resolve("/moved"));
    });

    test("an explicit root ignores the holder entirely", async () => {
        const holder = new ProjectRootHolder(resolveRootSync({ env: {}, cwd: () => "/start" }), {
            env: {},
            listRoots: async () => ({ roots: [{ uri: uri("/moved") }] }),
        });
        await holder.refresh();

        // Whoever passed a root is stating where the project is. A client's
        // open folder does not get to overrule that.
        const read = rootReader({ projectRoot: "/pinned", rootHolder: holder, env: {} });
        expect(read().path).toBe(path.resolve("/pinned"));
    });
});

describe("what an unconfirmed root says for itself", () => {
    test("it names the directory, the cause, and both ways out", () => {
        const message = unconfirmedRootMessage({
            path: "/scratch/outputs",
            source: "working-directory",
            via: "cwd",
            confirmed: false,
            otherRoots: [],
        });
        expect(message).toContain("/scratch/outputs");
        expect(message).toContain("No workspace root was supplied");
        expect(message).toContain("directory");
        expect(message).toContain("FACET_PROJECT_ROOT");
    });

    test("the Installed screen header says where it read and how it knew", () => {
        // Naming the variable matters: CLAUDE_PROJECT_DIR and FACET_PROJECT_ROOT
        // fail differently, and "from the environment" hides which one answered.
        expect(
            describeRoot({ path: "/p", source: "environment", via: "CLAUDE_PROJECT_DIR", confirmed: true, otherRoots: [] }),
        ).toBe("/p · from CLAUDE_PROJECT_DIR");
        expect(
            describeRoot({ path: "/p", source: "working-directory", via: "cwd", confirmed: false, otherRoots: [] }),
        ).toContain("unconfirmed");
    });
});

describe("the startup diagnostic", () => {
    // The two questions nobody could answer from inside a session: did the host
    // ask for UI, and where did the project root actually come from.
    const root = { path: "/proj", source: "environment" as const, via: "CLAUDE_PROJECT_DIR", confirmed: true, otherRoots: [] };

    test("it names the extension, the root, and which source supplied it", () => {
        const line = describeNegotiation({ ui: true, roots: true, root, looksLikeProject: true });
        expect(line).toContain("ui-extension=yes");
        expect(line).toContain("roots-capability=yes");
        expect(line).toContain("root=/proj");
        expect(line).toContain("via=CLAUDE_PROJECT_DIR");
        expect(line).toContain("facets-json=found");
    });

    test("a supplied root with no facets.json in it is the tell for a wrong env var", () => {
        // The Cowork hypothesis: CLAUDE_PROJECT_DIR points at the session's own
        // outputs directory, so the env branch is satisfied by a wrong value and
        // roots is never consulted. This line is how that becomes visible.
        const line = describeNegotiation({ ui: false, roots: true, root, looksLikeProject: false });
        expect(line).toContain("facets-json=absent");
        expect(line).toContain("confirmed=yes");
    });

    test("a silent host is distinguishable from a server with no UI", () => {
        expect(describeNegotiation({ ui: false, roots: false, root, looksLikeProject: true })).toContain("ui-extension=no");
    });

    test("other open folders are listed, so a wrong pick can be spotted", () => {
        const line = describeNegotiation({
            ui: true,
            roots: true,
            root: { ...root, source: "client-roots", via: "roots/list", otherRoots: ["/other"] },
            looksLikeProject: true,
        });
        expect(line).toContain("other-roots=/other");
    });
});
