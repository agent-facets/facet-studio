import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlugin } from "./build-plugin.ts";

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

interface FixtureOptions {
  skillDescription?: string;
  agentDescription?: string;
  commandDescription?: string;
}

// Writes a minimal facet source tree: one skill (with a companion file),
// one agent, one command. Returns the source dir.
async function writeFixtureFacet(opts: FixtureOptions = {}): Promise<string> {
  const src = await tempDir();

  await mkdir(join(src, "skills", "using-facets"), { recursive: true });
  await mkdir(join(src, "agents"), { recursive: true });
  await mkdir(join(src, "commands"), { recursive: true });

  await Bun.write(
    join(src, "facet.json"),
    JSON.stringify({
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
    }),
  );

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
    await mkdir(join(out, "stale-dir"), { recursive: true });
    await Bun.write(join(out, "stale-dir", "leftover.txt"), "should be gone");

    await buildPlugin(src, out);

    expect(await Bun.file(join(out, "stale-dir", "leftover.txt")).exists()).toBe(false);
  });

  test("generator never touches the source tree", async () => {
    const src = await writeFixtureFacet();
    const out = await tempDir();
    const before = await walk(src);

    await buildPlugin(src, out);

    const after = await walk(src);
    expect(after).toEqual(before);
  });
});
