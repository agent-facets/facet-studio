// Tests for the console — the three screens and the shell that holds them.
//
// Everything here is driven the way a person drives it: click a real button in
// the fake DOM, wait, assert on what redrew and on which tool the console asked
// for. Two of the tests go further and put a real MCP tool behind the port, so
// the payload the screen reads is one the server actually emitted rather than
// one this file made up.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerProject } from "../project.js";
import { registerAuthoring } from "../authoring.js";
import { ConsoleController, toPanelData, type ModifyArgs, type PanelElement } from "./panel.js";
import { toInstalledData } from "./installed.js";
import { toAuthorData } from "./author.js";
import {
    buttonsLabelled,
    buttonsStarting,
    fieldWithId,
    root,
    stubPorts,
    testDocument,
    text,
    type Element,
} from "./harness.js";
import type { ConsolePorts } from "./console.js";

function consoleOn(mount: Element, ports: ConsolePorts): ConsoleController {
    return new ConsoleController(mount as unknown as PanelElement, ports, testDocument);
}

/** Hands the console a payload the way the view script hands over a result. */
function deliver(controller: ConsoleController, payload: unknown, operation: string): void {
    controller.show(payload, toPanelData(payload, { operation }));
}

const INSTALLED = {
    kind: "installed",
    project: "demo",
    directory: "/tmp/demo",
    declared: true,
    locked: true,
    facets: [
        {
            name: "graphite",
            scope: "",
            shortName: "graphite",
            declared: "0.1.0",
            version: "0.1.0",
            origin: "registry",
            from: "https://api.agentfacets.io",
            installed: true,
            counts: [{ type: "skill", label: "1 Skill" }],
        },
    ],
    drift: [],
};

const AUTHOR = {
    kind: "author",
    present: true,
    directory: "/tmp/demo",
    name: "demo",
    version: "0.2.0",
    description: "A demo facet.",
    visibility: "public",
    assets: [{ type: "skill", name: "using-demo", detail: "How to use the demo." }],
    built: [],
};

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

describe("the console shell", () => {
    test("an operation updates the strip and leaves the screen where it was", async () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts({ project: async () => toInstalledData(INSTALLED) }));
        deliver(controller, INSTALLED, "Installed facets");
        expect(text(mount)).toContain("graphite");

        // A lifecycle result carries no screen of its own. The strip takes it,
        // and the list is re-read rather than replaced by a card.
        deliver(
            controller,
            { structuredContent: { facet: "cowsay", operation: "Add facet", status: "success", message: "Added cowsay@1.0.1.", assets: [] } },
            "Add facet",
        );
        await Bun.sleep(0);

        const drawn = text(mount);
        expect(drawn).toContain("Add facet");
        expect(drawn).toContain("Added cowsay@1.0.1.");
        // Still the installed screen, not a standalone result card.
        expect(drawn).toContain("graphite");
        expect(controller.snapshot().screen).toBe("installed");
    });

    test("a failed operation says so in the strip", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, { isError: true, content: [{ type: "text", text: "no such facet: nope" }] }, "Add facet");

        expect(text(mount)).toContain("no such facet: nope");
        expect(controller.snapshot().strip?.status).toBe("error");
    });

    test("the Authoring tab appears only once authoring actually happens", async () => {
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => toInstalledData(INSTALLED),
                manifest: async () => toAuthorData(AUTHOR),
            }),
        );

        // Browsing and managing installs offer no authoring — the tab is not
        // in the nav for someone who is not writing a facet.
        deliver(controller, INSTALLED, "Installed facets");
        expect(buttonsLabelled(mount, "Registry")).toHaveLength(1);
        expect(buttonsLabelled(mount, "Installed")).toHaveLength(1);
        expect(buttonsLabelled(mount, "Authoring")).toHaveLength(0);

        // An authoring result arriving is what earns the tab its place.
        deliver(controller, AUTHOR, "Read facet manifest");
        expect(buttonsLabelled(mount, "Authoring")).toHaveLength(1);
        expect(controller.snapshot().screen).toBe("author");

        // And it stays: moving away does not take the tab back out.
        controller.go("installed");
        await Bun.sleep(0);
        expect(buttonsLabelled(mount, "Authoring")).toHaveLength(1);
    });

    test("an authoring operation summons the tab too", async () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts({ manifest: async () => toAuthorData(AUTHOR) }));
        expect(buttonsLabelled(mount, "Authoring")).toHaveLength(0);

        deliver(
            controller,
            { structuredContent: { facet: "demo", operation: "Verify facet", status: "success", message: "Verified.", assets: [] } },
            "Verify facet",
        );
        await Bun.sleep(0);
        expect(buttonsLabelled(mount, "Authoring")).toHaveLength(1);
        expect(controller.snapshot().screen).toBe("author");
    });

    test("the nav moves between screens and reads the one it lands on", async () => {
        const asked: string[] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => {
                    asked.push("project");
                    return toInstalledData(INSTALLED);
                },
                manifest: async () => {
                    asked.push("manifest");
                    return toAuthorData(AUTHOR);
                },
            }),
        );

        controller.go("installed");
        await Bun.sleep(0);
        expect(text(mount)).toContain("graphite");

        controller.go("author");
        await Bun.sleep(0);
        expect(text(mount)).toContain("using-demo");
        expect(asked).toEqual(["project", "manifest"]);

        // Going back does not re-read what is already in hand.
        controller.go("installed");
        await Bun.sleep(0);
        expect(asked).toEqual(["project", "manifest"]);
    });
});

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------

describe("the installed screen", () => {
    test("draws what the real facet_project tool reports", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "facet-console-"));
        await writeFile(
            path.join(dir, "facets.json"),
            JSON.stringify({ manifestVersion: 0.1, facets: { "@scope/thing": "1.0.0", graphite: "0.1.0" } }),
        );
        await writeFile(
            path.join(dir, "facets.lock"),
            JSON.stringify({
                lockfileVersion: 0.3,
                facets: {
                    "@scope/thing": {
                        version: "1.0.0",
                        source: { kind: "registry", registry: "https://api.agentfacets.io" },
                        assets: [{ scope: "project", type: "skill", name: "thing-skill" }],
                    },
                },
            }),
        );

        const server = new McpServer({ name: "test", version: "0" });
        registerProject(server, { projectRoot: dir } as never);
        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = await client.callTool({ name: "facet_project", arguments: {} });
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, result, "Installed facets");

        const drawn = text(mount);
        expect(drawn).toContain("@scope/");
        expect(drawn).toContain("thing");
        expect(drawn).toContain("1 Skill");
        // graphite is declared but not locked, so the screen says so rather than
        // pretending it is installed.
        expect(drawn).toContain("graphite");
        expect(drawn).toContain("not installed");
        expect(drawn).toContain("nothing is locked for it");

        await client.close();
    });

    test("removing asks first, then runs facet_remove and offers to put it back", async () => {
        const calls: string[] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => toInstalledData(INSTALLED),
                remove: async name => {
                    calls.push(`remove ${name}`);
                    return { ok: true };
                },
                add: async (name, version) => {
                    calls.push(`add ${name}@${version ?? "latest"}`);
                    return { ok: true };
                },
            }),
        );
        deliver(controller, INSTALLED, "Installed facets");

        buttonsLabelled(mount, "Remove")[0].click();
        expect(text(mount)).toContain("Remove graphite and uninstall its assets?");
        expect(calls).toEqual([]);

        // Cancel really cancels.
        buttonsLabelled(mount, "Cancel")[0].click();
        expect(calls).toEqual([]);

        buttonsLabelled(mount, "Remove")[0].click();
        buttonsLabelled(mount, "Remove")[0].click();
        await Bun.sleep(0);
        expect(calls).toEqual(["remove graphite"]);
        expect(text(mount)).toContain("Removed");

        buttonsLabelled(mount, "Undo")[0].click();
        await Bun.sleep(0);
        // Put back at the version it was on, not at whatever is latest today.
        expect(calls).toEqual(["remove graphite", "add graphite@0.1.0"]);
    });

    test("an update is only offered once the registry has confirmed a newer version", async () => {
        const added: string[] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => toInstalledData(INSTALLED),
                detail: async name => ({
                    facet: name,
                    version: "0.3.0",
                    description: "",
                    publisher: "",
                    published: "",
                    visibility: "public",
                    counts: [],
                    assets: [],
                    versions: [],
                }),
                add: async (name, version) => {
                    added.push(`${name}@${version ?? "latest"}`);
                    return { ok: true };
                },
            }),
        );
        deliver(controller, INSTALLED, "Installed facets");

        // Nothing is claimed before the check runs.
        expect(buttonsStarting(mount, "Update to")).toHaveLength(0);

        buttonsLabelled(mount, "Check for updates")[0].click();
        await Bun.sleep(5);

        const update = buttonsStarting(mount, "Update to");
        expect(update).toHaveLength(1);
        expect(text(update[0])).toBe("Update to 0.3.0");

        update[0].click();
        await Bun.sleep(0);
        expect(added).toEqual(["graphite@0.3.0"]);
    });

    test("drift is named, and Repair runs facet install", async () => {
        const calls: string[] = [];
        const drifted = {
            ...INSTALLED,
            drift: [{ name: "ghost", reason: "not-installed", detail: "ghost is declared as 2.0.0 but nothing is locked for it." }],
        };
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => toInstalledData(drifted),
                install: async () => {
                    calls.push("install");
                    return { ok: true };
                },
            }),
        );
        deliver(controller, drifted, "Installed facets");

        expect(text(mount)).toContain("facets.json and facets.lock disagree");
        expect(text(mount)).toContain("ghost is declared as 2.0.0");

        buttonsLabelled(mount, "Repair")[0].click();
        await Bun.sleep(0);
        expect(calls).toEqual(["install"]);
    });

    test("an empty project points at the registry instead of showing a blank list", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(
            controller,
            { ...INSTALLED, declared: false, locked: false, facets: [] },
            "Installed facets",
        );

        expect(text(mount)).toContain("There is no facets.json here");
        expect(buttonsLabelled(mount, "Browse the registry")).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const DETAIL = {
    kind: "detail",
    facet: "graphite",
    version: "0.1.0",
    description: "Graphite-first version control.",
    publisher: "julian",
    published: "Jul 24",
    visibility: "public",
    counts: [{ type: "skill", label: "1 Skill" }],
    assets: [{ type: "skill", name: "using-graphite", detail: "Stacked branches." }],
    versions: ["0.1.0", "0.0.9"],
};

describe("the detail screen", () => {
    test("tabs switch, and the README is fetched only when its tab is opened", async () => {
        let readmeCalls = 0;
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                readme: async () => {
                    readmeCalls += 1;
                    return { file: "README.md", text: "# graphite\nStack your branches.", truncated: false };
                },
            }),
        );
        deliver(controller, DETAIL, "Facet detail");

        expect(text(mount)).toContain("using-graphite");
        expect(readmeCalls).toBe(0);

        buttonsLabelled(mount, "Versions")[0].click();
        expect(text(mount)).toContain("0.0.9");
        expect(text(mount)).toContain("showing");
        expect(readmeCalls).toBe(0);

        buttonsLabelled(mount, "README")[0].click();
        await Bun.sleep(0);
        expect(text(mount)).toContain("Stack your branches.");
        expect(readmeCalls).toBe(1);

        // Going away and back does not fetch it again.
        buttonsLabelled(mount, "Contents")[0].click();
        buttonsLabelled(mount, "README")[0].click();
        await Bun.sleep(0);
        expect(readmeCalls).toBe(1);
    });

    test("a version with no README says so rather than showing an empty box", async () => {
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({ readme: async () => ({ file: "", text: "", truncated: false }) }),
        );
        deliver(controller, DETAIL, "Facet detail");

        buttonsLabelled(mount, "README")[0].click();
        await Bun.sleep(0);
        expect(text(mount)).toContain("This version ships no README.");
    });

    test("back returns to the registry", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, DETAIL, "Facet detail");

        buttonsLabelled(mount, "← Registry")[0].click();
        expect(controller.snapshot().screen).toBe("registry");
    });
});

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

describe("the authoring screen", () => {
    test("draws what the real facet_manifest tool reports", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "facet-author-"));
        await writeFile(
            path.join(dir, "facet.json"),
            JSON.stringify({
                name: "demo",
                version: "0.2.0",
                description: "A demo facet.",
                skills: { "using-demo": { description: "How to use the demo." } },
                commands: { "demo-run": { description: "Run it." } },
            }),
        );

        const server = new McpServer({ name: "test", version: "0" });
        registerAuthoring(server, { projectRoot: dir } as never);
        const client = new Client({ name: "test-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);

        const result = await client.callTool({ name: "facet_manifest", arguments: {} });
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, result, "Read facet manifest");

        const drawn = text(mount);
        expect(drawn).toContain("using-demo");
        expect(drawn).toContain("How to use the demo.");
        expect(drawn).toContain("demo-run");
        expect(drawn).toContain("Nothing built yet.");
        // No publish button, because there is no publish tool behind one.
        expect(buttonsLabelled(mount, "Publish")).toHaveLength(0);
        expect(drawn).toContain("Publishing runs from the CLI");

        await client.close();
    });

    test("saving sends only the fields that changed, then re-reads the manifest", async () => {
        const edits: ModifyArgs[] = [];
        let reads = 0;
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                manifest: async () => {
                    reads += 1;
                    return toAuthorData(AUTHOR);
                },
                modify: async args => {
                    edits.push(args);
                    return { ok: true };
                },
            }),
        );
        deliver(controller, AUTHOR, "Read facet manifest");

        const description = fieldWithId(mount, "facet-field-description");
        expect(description).toBeDefined();
        description!.type("A demo facet, described better.");

        buttonsLabelled(mount, "Save")[0].click();
        await Bun.sleep(0);

        expect(edits).toEqual([{ target: "facet", description: "A demo facet, described better." }]);
        // Nothing is drawn from what we asked for — only from what the file says
        // once the CLI has been through it.
        expect(reads).toBe(1);
    });

    test("a version bump fills the field with the next version along", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, AUTHOR, "Read facet manifest");

        buttonsStarting(mount, "minor")[0].click();
        expect(fieldWithId(mount, "facet-field-version")?.value).toBe("0.3.0");

        buttonsLabelled(mount, "Revert")[0].click();
        expect(fieldWithId(mount, "facet-field-version")?.value).toBe("0.2.0");
    });

    test("typing does not redraw the field being typed into", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, AUTHOR, "Read facet manifest");

        const before = fieldWithId(mount, "facet-field-description");
        before!.type("half a sen");
        // The very same element, still in the tree: a redraw here would replace
        // it under the cursor and lose what was typed.
        expect(fieldWithId(mount, "facet-field-description")).toBe(before!);
        expect(before!.value).toBe("half a sen");
    });

    test("making a facet private is confirmed, because it cannot be undone", async () => {
        const edits: ModifyArgs[] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                manifest: async () => toAuthorData(AUTHOR),
                modify: async args => {
                    edits.push(args);
                    return { ok: true };
                },
            }),
        );
        deliver(controller, AUTHOR, "Read facet manifest");

        buttonsLabelled(mount, "Make private")[0].click();
        expect(text(mount)).toContain("has no operation to clear it");
        expect(edits).toEqual([]);

        buttonsLabelled(mount, "Make private")[0].click();
        await Bun.sleep(0);
        expect(edits).toEqual([{ target: "facet", private: true }]);
    });

    test("assets can be added and deleted, each through facet_modify", async () => {
        const edits: ModifyArgs[] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                manifest: async () => toAuthorData(AUTHOR),
                modify: async args => {
                    edits.push(args);
                    return { ok: true };
                },
            }),
        );
        deliver(controller, AUTHOR, "Read facet manifest");

        buttonsLabelled(mount, "Delete")[0].click();
        expect(text(mount)).toContain("Delete using-demo and its file?");
        buttonsLabelled(mount, "Delete")[0].click();
        await Bun.sleep(0);
        expect(edits[0]).toEqual({ target: "skill", name: "using-demo", remove: true });

        fieldWithId(mount, "facet-new-asset")!.type("new-command");
        buttonsLabelled(mount, "Command")[0].click();
        buttonsLabelled(mount, "Add")[0].click();
        await Bun.sleep(0);
        expect(edits[1]).toEqual({ target: "command", name: "new-command", add: true });
    });

    test("verify runs and reports what the CLI said", async () => {
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({ verify: async () => ({ ok: false, message: "skills/demo/SKILL.md is missing a description." }) }),
        );
        deliver(controller, AUTHOR, "Read facet manifest");

        buttonsLabelled(mount, "Verify")[0].click();
        await Bun.sleep(0);

        expect(text(mount)).toContain("skills/demo/SKILL.md is missing a description.");
        expect(buttonsLabelled(mount, "Verify failed — retry")).toHaveLength(1);
    });

    test("a directory with no facet.json says what to do about it", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(controller, { ...AUTHOR, present: false, assets: [] }, "Read facet manifest");

        expect(text(mount)).toContain("There is no facet.json here");
        expect(text(mount)).toContain("facet_create");
    });
});

// ---------------------------------------------------------------------------
// The registry screen
// ---------------------------------------------------------------------------

/** A gallery facet the way ports.browse hands one over. */
function facetNamed(
    name: string,
    counts?: { type: string; label: string }[],
    installed?: { version: string; updateAvailable: boolean },
): {
    name: string;
    version: string;
    description: string;
    publisher: string;
    published: string;
    counts: { type: string; label: string }[];
    installed?: { version: string; updateAvailable: boolean };
} {
    return {
        name,
        version: "1.0.0",
        description: `The ${name} facet.`,
        publisher: "julian",
        published: "Jul 29",
        counts: counts ?? [{ type: "skill", label: "1 Skill" }],
        ...(installed === undefined ? {} : { installed }),
    };
}

describe("the registry screen", () => {
    test("a failed browse lands on the registry and fetches it with arguments that work", async () => {
        const calls: [string, number | undefined][] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async (query, limit) => {
                    calls.push([query, limit]);
                    return { query, results: [facetNamed("openspec")] };
                },
            }),
        );

        // The host's model asked for the registry and fumbled the arguments.
        // The refusal goes on the strip — and the screen the user actually
        // asked about opens anyway, read with arguments the console controls.
        deliver(
            controller,
            { isError: true, content: [{ type: "text", text: "Invalid arguments for tool facet_browse" }] },
            "facet_browse",
        );
        await Bun.sleep(0);

        expect(controller.snapshot().screen).toBe("registry");
        expect(calls).toEqual([["", 24]]);
        expect(text(mount)).toContain("openspec");
        expect(controller.snapshot().strip?.status).toBe("error");
    });

    test("the search box runs facet_browse and keeps its words", async () => {
        const calls: [string, number | undefined][] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async (query, limit) => {
                    calls.push([query, limit]);
                    return { query, results: [] };
                },
            }),
        );
        controller.start("registry");
        await Bun.sleep(0);

        const box = fieldWithId(mount, "registry-search");
        expect(box).toBeDefined();
        box?.type("openspec");
        buttonsLabelled(mount, "Search")[0]?.click();
        await Bun.sleep(0);

        expect(calls).toEqual([
            ["", 24],
            ["openspec", 24],
        ]);
        // The redraw keeps what was searched in the box, not a blank field.
        expect(fieldWithId(mount, "registry-search")?.value).toBe("openspec");

        // Enter submits too, without needing the button.
        fieldWithId(mount, "registry-search")?.type("cowsay");
        fieldWithId(mount, "registry-search")?.fire("keydown", { key: "Enter" });
        await Bun.sleep(0);
        expect(calls[2]).toEqual(["cowsay", 24]);
    });

    test("results beyond a page sit behind the pager", async () => {
        const mount = root();
        const names = Array.from({ length: 20 }, (_, i) => `facet-${String(i).padStart(2, "0")}`);
        const controller = consoleOn(
            mount,
            stubPorts({ browse: async query => ({ query, results: names.map(name => facetNamed(name)) }) }),
        );
        controller.start("registry");
        await Bun.sleep(0);

        // Eight cards on the first page, and the pager says where you are.
        expect(buttonsLabelled(mount, "Install")).toHaveLength(8);
        expect(text(mount)).toContain("facet-00");
        expect(text(mount)).not.toContain("facet-08");
        expect(text(mount)).toContain("1–8 of 20");

        buttonsLabelled(mount, "Next ›")[0]?.click();
        expect(text(mount)).toContain("facet-08");
        expect(text(mount)).not.toContain("facet-00");
        expect(text(mount)).toContain("9–16 of 20");

        // The last page holds the remainder, and Next goes no further.
        buttonsLabelled(mount, "Next ›")[0]?.click();
        expect(text(mount)).toContain("17–20 of 20");
        expect(buttonsLabelled(mount, "Install")).toHaveLength(4);

        // A new filter starts back at the first page.
        buttonsLabelled(mount, "‹ Prev")[0]?.click();
        buttonsLabelled(mount, "Skills")[0]?.click();
        expect(text(mount)).toContain("facet-00");
    });

    test("chip pre-selection via show(): a delivered browse result seeds the filter from its type", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        // A bare gallery record, the shape readGallery() matches directly off
        // `kind` — this is show()'s branch, not the console's own self-fetch.
        deliver(
            controller,
            {
                kind: "gallery",
                query: "",
                type: "skill",
                results: [
                    facetNamed("git-skills"),
                    facetNamed("web-skills"),
                    facetNamed("agent-only", [{ type: "agent", label: "1 Agent" }]),
                ],
            },
            "facet_browse",
        );

        expect(controller.snapshot().screen).toBe("registry");
        // Skills chip is pre-selected with filter-on class.
        const skillsChip = buttonsLabelled(mount, "Skills")[0];
        expect(skillsChip?.className).toContain("filter-on");

        // Only skill-carrying facets are drawn; agent-only is filtered out.
        expect(text(mount)).toContain("git-skills");
        expect(text(mount)).toContain("web-skills");
        expect(text(mount)).not.toContain("agent-only");
    });

    test("chip pre-selection via show(): a delivered browse result without type defaults to 'all'", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(
            controller,
            { kind: "gallery", query: "", results: [facetNamed("some-facet")] },
            "facet_browse",
        );

        // Everything chip is pre-selected with filter-on class.
        const everythingChip = buttonsLabelled(mount, "Everything")[0];
        expect(everythingChip?.className).toContain("filter-on");

        // Results are drawn.
        expect(text(mount)).toContain("some-facet");
    });

    test("chip pre-selection via show(): user clicking another chip overrides the pre-selected filter", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(
            controller,
            { kind: "gallery", query: "", type: "skill", results: [facetNamed("test-facet")] },
            "facet_browse",
        );

        // Skills chip is initially on.
        expect(buttonsLabelled(mount, "Skills")[0]?.className).toContain("filter-on");

        // User clicks Agents chip.
        buttonsLabelled(mount, "Agents")[0]?.click();

        // Agents chip is now on, Skills is off.
        expect(buttonsLabelled(mount, "Agents")[0]?.className).toContain("filter-on");
        expect(buttonsLabelled(mount, "Skills")[0]?.className).not.toContain("filter-on");
    });

    test("chip pre-selection via loadRegistry(): the console's own self-fetch seeds the filter too", async () => {
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async query => ({
                    query,
                    type: "skill",
                    results: [
                        facetNamed("git-skills"),
                        facetNamed("agent-only", [{ type: "agent", label: "1 Agent" }]),
                    ],
                }),
            }),
        );
        controller.start("registry");
        await Bun.sleep(0);

        const skillsChip = buttonsLabelled(mount, "Skills")[0];
        expect(skillsChip?.className).toContain("filter-on");
        expect(text(mount)).toContain("git-skills");
        expect(text(mount)).not.toContain("agent-only");
    });

    test("degraded path: summary result without _meta self-loads registry via browse", async () => {
        const browseCount = { calls: 0 };
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async () => {
                    browseCount.calls++;
                    return { query: "", results: [facetNamed("loaded-facet")] };
                },
            }),
        );

        // Deliver a summary-kind result with no _meta (what a _meta-stripping host would hand to toolresult).
        deliver(
            controller,
            { structuredContent: { kind: "gallery-summary", names: ["skill1", "skill2"] } },
            "facet_browse",
        );
        await Bun.sleep(0);

        // browse was called once and the registry screen renders its result.
        expect(browseCount.calls).toBe(1);
        expect(controller.snapshot().screen).toBe("registry");
        expect(text(mount)).toContain("loaded-facet");
    });

    // -----------------------------------------------------------------------
    // Install state seeded from the server's join
    // -----------------------------------------------------------------------

    /** "Installed" labels a card CTA and the nav's own tab; this is the card's alone. */
    function cardButtonsLabelled(node: Element, label: string): Element[] {
        return buttonsLabelled(node, label).filter(button => !button.className.includes("nav-item"));
    }

    test("a not-installed row still runs today's install flow", async () => {
        const added: string[] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => toInstalledData(INSTALLED),
                add: async (name, version) => {
                    added.push(`${name}@${version ?? "latest"}`);
                    return { ok: true };
                },
            }),
        );
        deliver(controller, { kind: "gallery", query: "", results: [facetNamed("openspec")] }, "facet_browse");

        buttonsLabelled(mount, "Install")[0]?.click();
        await Bun.sleep(0);

        expect(added).toEqual(["openspec@1.0.0"]);
        expect(cardButtonsLabelled(mount, "Installed")).toHaveLength(1);
    });

    test("a server-installed row renders Installed, with no active Install button", () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts());
        deliver(
            controller,
            {
                kind: "gallery",
                query: "",
                results: [facetNamed("graphite", undefined, { version: "1.0.0", updateAvailable: false })],
            },
            "facet_browse",
        );

        const installed = cardButtonsLabelled(mount, "Installed");
        expect(installed).toHaveLength(1);
        expect(installed[0]?.attrs.get("disabled")).toBe("true");
        expect(buttonsLabelled(mount, "Install")).toHaveLength(0);
    });

    test("an update-available row offers Update to <registry version>, and it installs like today's flow", async () => {
        const added: [string, string | undefined][] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                project: async () => toInstalledData(INSTALLED),
                add: async (name, version) => {
                    added.push([name, version]);
                    return { ok: true };
                },
            }),
        );
        deliver(
            controller,
            {
                kind: "gallery",
                query: "",
                results: [facetNamed("graphite", undefined, { version: "0.1.0", updateAvailable: true })],
            },
            "facet_browse",
        );

        const update = buttonsStarting(mount, "Update to");
        expect(update).toHaveLength(1);
        expect(text(update[0])).toBe("Update to 1.0.0");

        update[0]?.click();
        await Bun.sleep(0);

        expect(added).toEqual([["graphite", "1.0.0"]]);
        expect(cardButtonsLabelled(mount, "Installed")).toHaveLength(1);
    });

    test("a failed update shows the error strip, same as a failed install", async () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts({ add: async () => ({ ok: false, message: "registry unreachable" }) }));
        deliver(
            controller,
            {
                kind: "gallery",
                query: "",
                results: [facetNamed("graphite", undefined, { version: "0.1.0", updateAvailable: true })],
            },
            "facet_browse",
        );

        buttonsStarting(mount, "Update to")[0]?.click();
        await Bun.sleep(0);

        expect(text(mount)).toContain("registry unreachable");
        expect(buttonsLabelled(mount, "Retry")).toHaveLength(1);
    });

    test("session state wins: a failed update shows the failure, not the server's installed snapshot", async () => {
        const mount = root();
        const controller = consoleOn(mount, stubPorts({ add: async () => ({ ok: false, message: "network error" }) }));
        deliver(
            controller,
            {
                kind: "gallery",
                query: "",
                results: [facetNamed("graphite", undefined, { version: "1.0.0", updateAvailable: true })],
            },
            "facet_browse",
        );

        buttonsStarting(mount, "Update to")[0]?.click();
        await Bun.sleep(0);

        expect(cardButtonsLabelled(mount, "Installed")).toHaveLength(0);
        expect(buttonsStarting(mount, "Update to")).toHaveLength(0);
        expect(buttonsLabelled(mount, "Retry")).toHaveLength(1);
        expect(text(mount)).toContain("network error");
    });

    // -----------------------------------------------------------------------
    // Load more
    // -----------------------------------------------------------------------

    test("Load more appends new results and dedupes by name, keeping first occurrence", async () => {
        const calls: [string, number | undefined, string | undefined][] = [];
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async (query, limit, cursor) => {
                    calls.push([query, limit, cursor]);
                    if (cursor === undefined) {
                        return {
                            query,
                            results: [
                                facetNamed("facet-00"),
                                facetNamed("facet-01"),
                                facetNamed("facet-02"),
                                facetNamed("facet-03"),
                            ],
                            nextCursor: "page2cursor",
                        };
                    } else if (cursor === "page2cursor") {
                        return {
                            query,
                            results: [
                                facetNamed("facet-03"), // Duplicate - should be skipped
                                facetNamed("facet-04"),
                                facetNamed("facet-05"),
                            ],
                            // No nextCursor - this is the last page
                        };
                    }
                    return { query, results: [] };
                },
            }),
        );
        controller.start("registry");
        await Bun.sleep(0);

        // First page shows 4 facets
        expect(text(mount)).toContain("facet-00");
        expect(text(mount)).toContain("facet-03");
        expect(text(mount)).not.toContain("facet-04");

        // Load more button exists and is clickable
        const loadMoreBtn = buttonsLabelled(mount, "Load more");
        expect(loadMoreBtn).toHaveLength(1);

        loadMoreBtn[0]?.click();
        await Bun.sleep(0);

        // After loading, page shows all 6 facets (4 original + 2 new, facet-03 deduplicated)
        expect(text(mount)).toContain("facet-00");
        expect(text(mount)).toContain("facet-04");
        expect(text(mount)).toContain("facet-05");

        // Load more button disappears because nextCursor is undefined
        expect(buttonsLabelled(mount, "Load more")).toHaveLength(0);

        // Verify cursor was passed correctly on second call
        expect(calls).toEqual([
            ["", 24, undefined],
            ["", 24, "page2cursor"],
        ]);
    });

    test("new search resets accumulated rows and cursor", async () => {
        const browseCount = { calls: 0 };
        const mount = root();
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async (query, limit, cursor) => {
                    browseCount.calls++;
                    if (cursor === undefined) {
                        return {
                            query,
                            results: [facetNamed("first-page-facet")],
                            nextCursor: "page2",
                        };
                    }
                    return { query, results: [facetNamed("second-page-facet")] };
                },
            }),
        );
        controller.start("registry");
        await Bun.sleep(0);

        expect(text(mount)).toContain("first-page-facet");
        expect(text(mount)).not.toContain("second-page-facet");

        // Simulate new search
        const box = fieldWithId(mount, "registry-search");
        box?.type("newquery");
        buttonsLabelled(mount, "Search")[0]?.click();
        await Bun.sleep(0);

        // Old results are gone, new search results shown
        expect(text(mount)).toContain("first-page-facet");
        // Load more button should exist for new results
        expect(buttonsLabelled(mount, "Load more")).toHaveLength(1);

        // Load more button is initially not loading
        expect(buttonsLabelled(mount, "Loading…")).toHaveLength(0);
    });

    test("load-more shows loading state and handles errors by restoring the button", async () => {
        const mount = root();
        let shouldFail = false;
        const controller = consoleOn(
            mount,
            stubPorts({
                browse: async (query, limit, cursor) => {
                    if (shouldFail && cursor !== undefined) {
                        throw new Error("Network error");
                    }
                    return {
                        query,
                        results: cursor === undefined ? [facetNamed("facet-1")] : [facetNamed("facet-2")],
                        nextCursor: cursor === undefined ? "cursor2" : undefined,
                    };
                },
            }),
        );
        controller.start("registry");
        await Bun.sleep(0);

        // Load more exists and works
        expect(buttonsLabelled(mount, "Load more")).toHaveLength(1);

        // Trigger failure
        shouldFail = true;
        buttonsLabelled(mount, "Load more")[0]?.click();
        await Bun.sleep(0);

        // After error, button is back and not disabled
        expect(buttonsLabelled(mount, "Load more")).toHaveLength(1);
        const btn = buttonsLabelled(mount, "Load more")[0];
        expect(btn?.attrs.get("disabled")).not.toBe("disabled");
    });
});
