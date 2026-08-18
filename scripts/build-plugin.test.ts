import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_MARKER, assertSafeOutDir, buildPlugin } from "./build-plugin.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "build-plugin-"));
  cleanupDirs.push(dir);
  return dir;
}

// The adversarial description: embeds a colon, a quoted value, a `#`
// comment marker, and a real newline - anything that could break out of a
// naive `description: <raw>` YAML line if we ever stopped JSON-encoding it.
const INJECTION_DESCRIPTION = 'x: "y" # {z}\nnewline';

// What a fixture MCP server prints when it runs. The greeting lives in a
// second module so the bundle has to inline a local import to work at all.
const SERVER_GREETING = "fixture server online";

interface FixtureOptions {
  skillDescription?: string;
  agentDescription?: string;
  commandDescription?: string;
  /**
   * Give the fixture an MCP server at mcp/src/server.ts. "broken" writes one
   * that cannot possibly bundle (it imports a package that isn't installed).
   */
  mcpServer?: "working" | "broken";
  /** Put the fixture in this directory instead of a fresh temp one. */
  dir?: string;
  /** Last word on facet.json: rewrite it however the test needs before it lands. */
  mutateManifest?: (manifest: Record<string, any>) => void;
}

// Writes a minimal facet source tree: one skill (with a companion file),
// one agent, one command. Returns the source dir.
async function writeFixtureFacet(opts: FixtureOptions = {}): Promise<string> {
  const src = opts.dir ?? (await tempDir());
  await mkdir(src, { recursive: true });

  if (opts.mcpServer !== undefined) {
    await mkdir(join(src, "mcp", "src"), { recursive: true });
    await Bun.write(join(src, "mcp", "src", "greeting.ts"), `export const GREETING = "${SERVER_GREETING}";\n`);
    await Bun.write(
      join(src, "mcp", "src", "server.ts"),
      opts.mcpServer === "broken"
        ? 'import { nope } from "@not-installed/definitely-missing";\nconsole.log(nope);\n'
        : 'import { GREETING } from "./greeting.ts";\nprocess.stdout.write(`${GREETING}\\n`);\n',
    );
  }

  await mkdir(join(src, "skills", "using-facets"), { recursive: true });
  await mkdir(join(src, "agents"), { recursive: true });
  await mkdir(join(src, "commands"), { recursive: true });

  const manifest: Record<string, any> = {
    name: "fixture-facet",
    version: "0.1.0",
    description: "A fixture facet for build-plugin tests.",
    skills: {
      "using-facets": {
        description: opts.skillDescription ?? "Load BEFORE any facet operation.",
        files: ["reference.txt"],
      },
    },
    agents: {
      "demo-agent": {
        description: opts.agentDescription ?? "Demo agent for tests.",
      },
    },
    commands: {
      "demo-command": {
        description: opts.commandDescription ?? "Demo command for tests.",
      },
    },
  };
  opts.mutateManifest?.(manifest);
  await Bun.write(join(src, "facet.json"), JSON.stringify(manifest));

  await Bun.write(join(src, "skills", "using-facets", "SKILL.md"), "# Using Facets\n\nSkill body.\n");
  await Bun.write(join(src, "skills", "using-facets", "reference.txt"), "companion bytes\x00\xff\n");
  await Bun.write(join(src, "agents", "demo-agent.md"), "# Demo Agent\n\nAgent body.\n");
  await Bun.write(join(src, "commands", "demo-command.md"), "# Demo Command\n\nCommand body.\n");

  return src;
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walk(full, base)));
    } else {
      paths.push(full.slice(base.length + 1));
    }
  }
  return paths.sort();
}

describe("buildPlugin", () => {
  test("emits plugin.json with required fields including author", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const manifest = await Bun.file(join(out, ".claude-plugin", "plugin.json")).json();
    expect(manifest).toEqual({
      name: "fixture-facet",
      version: "0.1.0",
      description: "A fixture facet for build-plugin tests.",
      author: { name: "James Dunnam" },
    });
  });

  test("skill frontmatter is name+description, JSON-encoded, no fenced envelope, body-second", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const content = await Bun.file(join(out, "skills", "using-facets", "SKILL.md")).text();
    const expected =
      `---\nname: using-facets\ndescription: ${JSON.stringify(
        "Load BEFORE any facet operation.",
      )}\n---\n\n# Using Facets\n\nSkill body.\n`;
    expect(content).toBe(expected);
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).not.toContain("```yaml");
  });

  test("agent frontmatter is name+description", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const content = await Bun.file(join(out, "agents", "demo-agent.md")).text();
    const expected =
      `---\nname: demo-agent\ndescription: ${JSON.stringify(
        "Demo agent for tests.",
      )}\n---\n\n# Demo Agent\n\nAgent body.\n`;
    expect(content).toBe(expected);
  });

  test("command frontmatter is description-only (no name field)", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const content = await Bun.file(join(out, "commands", "demo-command.md")).text();
    const expected =
      `---\ndescription: ${JSON.stringify("Demo command for tests.")}\n---\n\n# Demo Command\n\nCommand body.\n`;
    expect(content).toBe(expected);
    expect(content).not.toContain("name:");
  });

  test("declared companion file is copied byte-identical", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const srcBytes = await Bun.file(join(src, "skills", "using-facets", "reference.txt")).arrayBuffer();
    const outBytes = await Bun.file(join(out, "skills", "using-facets", "reference.txt")).arrayBuffer();
    expect(Buffer.from(outBytes).equals(Buffer.from(srcBytes))).toBe(true);

    // Companion files carry no frontmatter of their own.
    const outText = await Bun.file(join(out, "skills", "using-facets", "reference.txt")).text();
    expect(outText.startsWith("---")).toBe(false);
  });

  test("YAML-injection: description with colon, quote, hash, and newline round-trips safely", async () => {
    const src = await writeFixtureFacet({
      skillDescription: INJECTION_DESCRIPTION,
      agentDescription: INJECTION_DESCRIPTION,
      commandDescription: INJECTION_DESCRIPTION,
    });
    const out = await tempDir();
    await buildPlugin(src, out);

    for (const relPath of [
      join("skills", "using-facets", "SKILL.md"),
      join("agents", "demo-agent.md"),
      join("commands", "demo-command.md"),
    ]) {
      const content = await Bun.file(join(out, relPath)).text();
      const lines = content.split("\n");
      // Exactly one frontmatter block: first line "---", a closing "---"
      // line, nothing before it, no fenced ```yaml envelope anywhere.
      expect(lines[0]).toBe("---");
      expect(content).not.toContain("```yaml");

      const descriptionLine = lines.find((l) => l.startsWith("description: "));
      expect(descriptionLine).toBeDefined();
      const encoded = descriptionLine!.slice("description: ".length);
      // The encoded value must be a single JSON string literal - i.e. it
      // never breaks the line (no raw newline emitted) and it parses back
      // to exactly the original, hazardous description.
      const decoded = JSON.parse(encoded);
      expect(decoded).toBe(INJECTION_DESCRIPTION);
    }
  });

  test("determinism: two builds from the same source produce byte-identical trees", async () => {
    const src = await writeFixtureFacet();
    const out1 = await tempDir();
    const out2 = await tempDir();

    await buildPlugin(src, out1);
    await buildPlugin(src, out2);

    const files1 = await walk(out1);
    const files2 = await walk(out2);
    expect(files1).toEqual(files2);

    for (const rel of files1) {
      const b1 = await Bun.file(join(out1, rel)).arrayBuffer();
      const b2 = await Bun.file(join(out2, rel)).arrayBuffer();
      expect(Buffer.from(b1).equals(Buffer.from(b2))).toBe(true);
    }
  });

  test("outDir is wiped before writing (stale files from a previous build do not survive)", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();

    // Build once so the directory is genuinely a previous output - that is what
    // earns it the right to be wiped - then leave junk behind in it.
    await buildPlugin(src, out);
    await mkdir(join(out, "stale-dir"), { recursive: true });
    await Bun.write(join(out, "stale-dir", "leftover.txt"), "should be gone");

    await buildPlugin(src, out);

    expect(await Bun.file(join(out, "stale-dir", "leftover.txt")).exists()).toBe(false);
    expect(await Bun.file(join(out, ".claude-plugin", "plugin.json")).exists()).toBe(true);
  });

  test("every build leaves its marker at the top of the output", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const marker = Bun.file(join(out, OUTPUT_MARKER));
    expect(await marker.exists()).toBe(true);
    expect(await marker.text()).toContain("build-plugin");
    expect(await walk(out)).toContain(OUTPUT_MARKER);
  });

  test("generator never touches the source tree", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    const before = await walk(src);

    await buildPlugin(src, out);

    const after = await walk(src);
    expect(after).toEqual(before);
  });

  test("a facet without an MCP server gets no mcpServers key and no mcp directory", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await buildPlugin(src, out);

    const manifest = await Bun.file(join(out, ".claude-plugin", "plugin.json")).json();
    expect(manifest.mcpServers).toBeUndefined();
    expect((await walk(out)).some((rel) => rel.startsWith("mcp"))).toBe(false);
  });
});

describe("buildPlugin with an MCP server", () => {
  test("plugin.json declares the server under the facet's name, launched from the plugin root", async () => {
    const src = await writeFixtureFacet({ mcpServer: "working" });
    const out = await tempDir();
    await buildPlugin(src, out);

    const manifest = await Bun.file(join(out, ".claude-plugin", "plugin.json")).json();
    // Whole-manifest comparison: the v1 fields have to survive untouched, and
    // the new key has to be exactly this shape - the launch path is a literal
    // ${CLAUDE_PLUGIN_ROOT}, expanded by Claude Code, not by us.
    expect(manifest).toEqual({
      name: "fixture-facet",
      version: "0.1.0",
      description: "A fixture facet for build-plugin tests.",
      author: { name: "James Dunnam" },
      mcpServers: {
        "fixture-facet": {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"],
        },
      },
    });
  });

  test("the declared bundle exists, is non-empty, and has the entry's local imports inlined", async () => {
    const src = await writeFixtureFacet({ mcpServer: "working" });
    const out = await tempDir();
    await buildPlugin(src, out);

    const bundle = Bun.file(join(out, "mcp", "server.mjs"));
    expect(await bundle.exists()).toBe(true);
    expect(bundle.size).toBeGreaterThan(0);
    // greeting.ts is never copied, so seeing its text proves the bundler
    // inlined the module rather than leaving an import to resolve at run time.
    expect(await bundle.text()).toContain(SERVER_GREETING);

    const emitted = (await walk(out)).filter((rel) => rel.startsWith("mcp"));
    expect(emitted).toEqual([join("mcp", "server.mjs")]);
  });

  test("the bundled server actually runs under node", async () => {
    const src = await writeFixtureFacet({ mcpServer: "working" });
    const out = await tempDir();
    await buildPlugin(src, out);

    // Existence is not enough: plugin validation passes on a file that cannot
    // run, so the test runs it the way the plugin loader would.
    const run = Bun.spawnSync(["node", join(out, "mcp", "server.mjs")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain(SERVER_GREETING);
  });

  test("determinism: two builds produce a byte-identical bundle and manifest", async () => {
    const src = await writeFixtureFacet({ mcpServer: "working" });
    const out1 = await tempDir();
    const out2 = await tempDir();

    await buildPlugin(src, out1);
    await buildPlugin(src, out2);

    const files1 = await walk(out1);
    expect(files1).toEqual(await walk(out2));
    expect(files1).toContain(join("mcp", "server.mjs"));

    for (const rel of files1) {
      const b1 = await Bun.file(join(out1, rel)).arrayBuffer();
      const b2 = await Bun.file(join(out2, rel)).arrayBuffer();
      expect(Buffer.from(b1).equals(Buffer.from(b2))).toBe(true);
    }
  });

  test("bundling leaves the source tree exactly as it found it", async () => {
    const src = await writeFixtureFacet({ mcpServer: "working" });
    const out = await tempDir();
    const before = await walk(src);

    await buildPlugin(src, out);

    expect(await walk(src)).toEqual(before);
  });

  test("a server that cannot bundle fails the build instead of declaring a missing file", async () => {
    const src = await writeFixtureFacet({ mcpServer: "broken" });
    const out = await tempDir();

    await expect(buildPlugin(src, out)).rejects.toThrow(/failed to bundle/);

    // Nothing may claim a server that isn't there: plugin validation happily
    // passes a manifest whose mcpServers file is missing, so the generator is
    // the only thing standing between a broken bundle and a shipped plugin.
    expect(await Bun.file(join(out, ".claude-plugin", "plugin.json")).exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Safety: the build wipes its output directory and reads whatever facet.json
// names, so both have to be provably refusable. Every fixture below lives in a
// throwaway temp directory - nothing here is ever pointed at the real repo,
// because a test that would delete the repository if a guard regressed is not
// a test worth having.
// ---------------------------------------------------------------------------

const VICTIM_BYTES = "do not touch\n";

// A facet with neighbours: `parent/facet` is the source tree, and next door sit
// files no build has any business reading or overwriting.
async function writeFixtureWithNeighbours(
  opts: FixtureOptions = {},
): Promise<{ parent: string; src: string; victimFile: string; victimSkill: string }> {
  const parent = await tempDir();
  const src = await writeFixtureFacet({ ...opts, dir: join(parent, "facet") });

  const victimFile = join(parent, "victim.txt");
  await Bun.write(victimFile, VICTIM_BYTES);
  const victimSkill = join(parent, "victim", "SKILL.md");
  await Bun.write(victimSkill, VICTIM_BYTES);

  return { parent, src, victimFile, victimSkill };
}

describe("buildPlugin refuses dangerous output directories", () => {
  test("building into the source tree itself is refused and the source survives", async () => {
    const src = await writeFixtureFacet();
    const before = await walk(src);

    await expect(buildPlugin(src, src)).rejects.toThrow("that is the facet source tree itself");

    expect(await walk(src)).toEqual(before);
  });

  test("an output directory containing the source tree is refused", async () => {
    const { parent, src } = await writeFixtureWithNeighbours();
    const before = await walk(parent);

    await expect(buildPlugin(src, parent)).rejects.toThrow("it contains the facet source tree");

    expect(await walk(parent)).toEqual(before);
  });

  test("a symlink aimed back at the source tree is refused as well", async () => {
    const src = await writeFixtureFacet();
    const link = join(await tempDir(), "out-link");
    await symlink(src, link);
    const before = await walk(src);

    await expect(buildPlugin(src, link)).rejects.toThrow("refusing to build into");

    expect(await walk(src)).toEqual(before);
  });

  test("an output directory holding a .git or a facet.json is refused, marker intact", async () => {
    for (const marker of [".git", "facet.json"]) {
      const src = await writeFixtureFacet();
      const out = await tempDir();
      await Bun.write(join(out, marker), "sentinel");

      await expect(buildPlugin(src, out)).rejects.toThrow(`it holds a ${marker}`);

      expect(await Bun.file(join(out, marker)).text()).toBe("sentinel");
    }
  });

  test("the repository root is refused - exercised against a stand-in, never the real repo", async () => {
    const src = await writeFixtureFacet();
    const pretendRepoRoot = await tempDir();

    await expect(assertSafeOutDir(src, pretendRepoRoot, pretendRepoRoot)).rejects.toThrow(
      "that is this repository's root",
    );
    // Same check, a directory that isn't the root: allowed.
    await expect(assertSafeOutDir(src, await tempDir(), pretendRepoRoot)).resolves.toBeUndefined();
  });

  test("a filesystem root is refused", async () => {
    const src = await writeFixtureFacet();
    await expect(assertSafeOutDir(src, "/")).rejects.toThrow("refusing to build into /");
  });

  test("a refused build deletes nothing already in the output directory", async () => {
    const { src } = await writeFixtureWithNeighbours({
      mutateManifest: (m) => {
        m.skills = { "../../victim": { description: "traverses out of the source tree" } };
      },
    });
    // A directory the generator is allowed to wipe (it carries the marker), so
    // the only thing standing between keep.txt and deletion is the manifest
    // being validated first.
    const out = await tempDir();
    await Bun.write(join(out, OUTPUT_MARKER), "generated\n");
    await Bun.write(join(out, "keep.txt"), "still here");

    await expect(buildPlugin(src, out)).rejects.toThrow("asset names");

    // Proof the manifest is validated before the wipe, not after it.
    expect(await Bun.file(join(out, "keep.txt")).text()).toBe("still here");
  });
});

// ---------------------------------------------------------------------------
// The nested-output hazard: an output directory can sit inside the source tree
// without being the source tree, and the name-based guards above see nothing
// wrong with it. `--out skills` used to delete every skill in the facet. What
// saves it is what the target already holds, not where it sits.
// ---------------------------------------------------------------------------

describe("buildPlugin refuses an output directory that holds files it did not generate", () => {
  test("a source directory nested inside the facet is refused and its contents survive", async () => {
    const src = await writeFixtureFacet();
    const before = await walk(src);
    const skillBytes = await Bun.file(join(src, "skills", "using-facets", "reference.txt")).arrayBuffer();

    // The exact repro: `bun scripts/build-plugin.ts --out skills` from the
    // facet root. Nothing here points anywhere but a throwaway temp fixture.
    await expect(buildPlugin(src, join(src, "skills"))).rejects.toThrow(
      "already holds files this build did not generate",
    );

    expect(await walk(src)).toEqual(before);
    const after = await Bun.file(join(src, "skills", "using-facets", "reference.txt")).arrayBuffer();
    expect(Buffer.from(after).equals(Buffer.from(skillBytes))).toBe(true);
  });

  test("every other directory in the source tree is refused too", async () => {
    const src = await writeFixtureFacet();
    for (const nested of ["agents", "commands", join("skills", "using-facets")]) {
      const before = await walk(src);
      await expect(buildPlugin(src, join(src, nested))).rejects.toThrow("refusing to build into");
      expect(await walk(src)).toEqual(before);
    }
  });

  test("a non-empty unrelated directory is refused, contents intact", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await mkdir(join(out, "notes"), { recursive: true });
    await Bun.write(join(out, "notes", "todo.md"), VICTIM_BYTES);
    await Bun.write(join(out, "photo.jpg"), VICTIM_BYTES);

    await expect(buildPlugin(src, out)).rejects.toThrow(
      "already holds files this build did not generate",
    );

    expect(await walk(out).then((f) => f.sort())).toEqual([join("notes", "todo.md"), "photo.jpg"].sort());
    expect(await Bun.file(join(out, "notes", "todo.md")).text()).toBe(VICTIM_BYTES);
  });

  test("an existing file at the output path is refused rather than deleted", async () => {
    const src = await writeFixtureFacet();
    const out = join(await tempDir(), "not-a-dir");
    await Bun.write(out, VICTIM_BYTES);

    await expect(buildPlugin(src, out)).rejects.toThrow("it is not a directory");

    expect(await Bun.file(out).text()).toBe(VICTIM_BYTES);
  });

  test("a path that does not exist yet is allowed", async () => {
    const src = await writeFixtureFacet();
    const out = join(await tempDir(), "deep", "fresh-output");

    await buildPlugin(src, out);

    expect(await Bun.file(join(out, ".claude-plugin", "plugin.json")).exists()).toBe(true);
  });

  test("an existing empty directory is allowed", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();

    await buildPlugin(src, out);

    expect(await Bun.file(join(out, ".claude-plugin", "plugin.json")).exists()).toBe(true);
  });

  test("the marker makes a directory wipeable no matter what else is in it", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await Bun.write(join(out, OUTPUT_MARKER), "generated\n");
    await Bun.write(join(out, "anything-at-all.txt"), "from an older build");

    await buildPlugin(src, out);

    expect(await Bun.file(join(out, "anything-at-all.txt")).exists()).toBe(false);
    expect(await Bun.file(join(out, OUTPUT_MARKER)).exists()).toBe(true);
  });

  test("a plugin directory built before markers existed is still wipeable", async () => {
    // What the committed plugin/ looks like: everything at the top level is
    // something this generator emits, and there is a plugin manifest - but no
    // marker, because it predates one.
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await Bun.write(join(out, ".claude-plugin", "plugin.json"), '{"name":"old"}');
    await Bun.write(join(out, "skills", "old-skill", "SKILL.md"), "old\n");
    await Bun.write(join(out, "agents", "old.md"), "old\n");

    await buildPlugin(src, out);

    expect(await Bun.file(join(out, "skills", "old-skill", "SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(out, OUTPUT_MARKER)).exists()).toBe(true);
  });

  test("that grandfather clause needs a plugin manifest, not just familiar names", async () => {
    // A source tree that happens to use the same directory names is not one of
    // ours: no manifest, no marker, no deletion.
    const src = await writeFixtureFacet();
    const out = await tempDir();
    await Bun.write(join(out, "skills", "mine", "SKILL.md"), VICTIM_BYTES);

    await expect(buildPlugin(src, out)).rejects.toThrow("already holds files this build did not generate");

    expect(await Bun.file(join(out, "skills", "mine", "SKILL.md")).text()).toBe(VICTIM_BYTES);
  });

  test("refusal happens before the wipe, so a second build stays deterministic", async () => {
    const src = await writeFixtureFacet();
    const out1 = await tempDir();
    const out2 = await tempDir();

    // Build, build again over the top (marker present), and compare against a
    // pristine build: rebuilding in place must produce the same bytes.
    await buildPlugin(src, out1);
    await buildPlugin(src, out1);
    await buildPlugin(src, out2);

    const files1 = await walk(out1);
    expect(files1).toEqual(await walk(out2));
    for (const rel of files1) {
      const b1 = await Bun.file(join(out1, rel)).arrayBuffer();
      const b2 = await Bun.file(join(out2, rel)).arrayBuffer();
      expect(Buffer.from(b1).equals(Buffer.from(b2))).toBe(true);
    }
  });
});

describe("buildPlugin refuses manifest paths that escape the trees", () => {
  test("a skill key that traverses out of the source tree is refused, victim untouched", async () => {
    const { src, victimSkill } = await writeFixtureWithNeighbours({
      mutateManifest: (m) => {
        // Would have read parent/victim/SKILL.md and written it back outside
        // the output directory.
        m.skills = { "../../victim": { description: "reads the file next door" } };
      },
    });
    const out = await tempDir();

    await expect(buildPlugin(src, out)).rejects.toThrow('declares a skill named "../../victim"');

    expect(await Bun.file(victimSkill).text()).toBe(VICTIM_BYTES);
    expect(await walk(out)).toEqual([]);
  });

  test("asset names outside the grammar are refused for every kind", async () => {
    const badNames = [
      "../victim",
      "/etc/passwd",
      "..",
      "Capitalized",
      "under_score",
      "dot.name",
      "trailing-",
      "double--hyphen",
      "",
      "a".repeat(65),
    ];

    for (const kind of ["skills", "agents", "commands"] as const) {
      for (const name of badNames) {
        const src = await writeFixtureFacet({
          mutateManifest: (m) => {
            m[kind] = { [name]: { description: "hostile name" } };
          },
        });
        const out = await tempDir();
        await expect(buildPlugin(src, out)).rejects.toThrow(`named ${JSON.stringify(name)}`);
        expect(await walk(out)).toEqual([]);
      }
    }
  });

  test("a companion path that traverses out of the source tree is refused, victim untouched", async () => {
    const { src, victimFile } = await writeFixtureWithNeighbours({
      mutateManifest: (m) => {
        m.skills["using-facets"].files = ["../../../victim.txt"];
      },
    });
    const out = await tempDir();

    await expect(buildPlugin(src, out)).rejects.toThrow("outside the facet source tree");

    expect(await Bun.file(victimFile).text()).toBe(VICTIM_BYTES);
    expect(await walk(out)).toEqual([]);
  });

  test("an absolute companion path is refused", async () => {
    const src = await writeFixtureFacet({
      mutateManifest: (m) => {
        m.skills["using-facets"].files = ["/etc/passwd"];
      },
    });
    const out = await tempDir();

    await expect(buildPlugin(src, out)).rejects.toThrow("outside the facet source tree");
    expect(await walk(out)).toEqual([]);
  });

  test("a companion symlink pointing outside the source tree is refused", async () => {
    const { src, victimFile } = await writeFixtureWithNeighbours({
      mutateManifest: (m) => {
        m.skills["using-facets"].files = ["leak.txt"];
      },
    });
    await symlink(victimFile, join(src, "skills", "using-facets", "leak.txt"));
    const out = await tempDir();

    await expect(buildPlugin(src, out)).rejects.toThrow("outside the facet source tree");
    expect(await walk(out)).toEqual([]);
  });

  test("a companion elsewhere inside the source tree is still allowed", async () => {
    const src = await writeFixtureFacet({
      mutateManifest: (m) => {
        m.skills["using-facets"].files = ["../shared/note.txt"];
      },
    });
    await mkdir(join(src, "skills", "shared"), { recursive: true });
    await Bun.write(join(src, "skills", "shared", "note.txt"), "shared note\n");
    const out = await tempDir();

    await buildPlugin(src, out);

    // The boundary is the source tree, not the skill's own directory - and the
    // copy lands inside the output tree at the matching relative path.
    expect(await Bun.file(join(out, "skills", "shared", "note.txt")).text()).toBe("shared note\n");
  });

  test("malformed manifest values are refused with a clear message", async () => {
    const cases: Array<[string, (m: Record<string, any>) => void]> = [
      ["name must be a non-empty string", (m) => delete m.name],
      ["description must be a non-empty string", (m) => (m.skills["using-facets"].description = 42)],
      ['"files" must be an array of paths', (m) => (m.skills["using-facets"].files = "reference.txt")],
      ["files[0] must be a non-empty string", (m) => (m.skills["using-facets"].files = [42])],
      ['"skills" must be an object keyed by asset name', (m) => (m.skills = ["using-facets"])],
    ];

    for (const [message, mutateManifest] of cases) {
      const src = await writeFixtureFacet({ mutateManifest });
      const out = await tempDir();
      await expect(buildPlugin(src, out)).rejects.toThrow(message);
      expect(await walk(out)).toEqual([]);
    }
  });
});
