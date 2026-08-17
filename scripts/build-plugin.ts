// Turns a facet source tree into a Claude Code plugin directory.
//
// A facet ships one source of truth (facet.json + skills/agents/commands
// markdown files). This script reads that source and emits the parallel
// layout Claude Code's plugin loader expects: a .claude-plugin/plugin.json
// manifest plus per-asset markdown files with YAML frontmatter. It never
// writes back into the source tree, and running it twice on the same input
// must produce byte-identical output (no timestamps, no random ids).

import { mkdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

const PLUGIN_AUTHOR = { name: "James Dunnam" };

interface FacetAsset {
  description: string;
  files?: string[];
}

interface FacetManifest {
  name: string;
  version: string;
  description: string;
  skills?: Record<string, FacetAsset>;
  agents?: Record<string, FacetAsset>;
  commands?: Record<string, FacetAsset>;
}

// Renders a YAML frontmatter block. `description` is arbitrary author text
// (it can contain colons, quotes, `#`, even newlines), so we always emit it
// as a JSON string literal - JSON scalars are valid YAML, and this sidesteps
// any risk of a description breaking out of the frontmatter or being parsed
// as a YAML directive. `name` is a facet-controlled identifier (a directory
// name), not free text, so it's safe to emit plain.
function renderFrontmatter(fields: Array<[string, string]>): string {
  const lines = fields.map(([key, value]) =>
    key === "name" ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n\n`;
}

async function readSourceBody(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`missing source file: ${path}`);
  }
  return file.text();
}

async function writeOutFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
}

async function emitSkills(
  srcDir: string,
  outDir: string,
  skills: Record<string, FacetAsset> | undefined,
): Promise<void> {
  for (const [name, asset] of Object.entries(skills ?? {})) {
    const srcPath = join(srcDir, "skills", name, "SKILL.md");
    const body = await readSourceBody(srcPath);
    const frontmatter = renderFrontmatter([
      ["name", name],
      ["description", asset.description],
    ]);
    await writeOutFile(join(outDir, "skills", name, "SKILL.md"), frontmatter + body);

    for (const companion of asset.files ?? []) {
      const companionSrc = join(srcDir, "skills", name, companion);
      const companionBytes = await Bun.file(companionSrc).arrayBuffer();
      await mkdir(dirname(join(outDir, "skills", name, companion)), { recursive: true });
      await Bun.write(join(outDir, "skills", name, companion), companionBytes);
    }
  }
}

async function emitAgents(
  srcDir: string,
  outDir: string,
  agents: Record<string, FacetAsset> | undefined,
): Promise<void> {
  for (const [name, asset] of Object.entries(agents ?? {})) {
    const srcPath = join(srcDir, "agents", `${name}.md`);
    const body = await readSourceBody(srcPath);
    const frontmatter = renderFrontmatter([
      ["name", name],
      ["description", asset.description],
    ]);
    await writeOutFile(join(outDir, "agents", `${name}.md`), frontmatter + body);
  }
}

async function emitCommands(
  srcDir: string,
  outDir: string,
  commands: Record<string, FacetAsset> | undefined,
): Promise<void> {
  for (const [name, asset] of Object.entries(commands ?? {})) {
    const srcPath = join(srcDir, "commands", `${name}.md`);
    const body = await readSourceBody(srcPath);
    const frontmatter = renderFrontmatter([["description", asset.description]]);
    await writeOutFile(join(outDir, "commands", `${name}.md`), frontmatter + body);
  }
}

/**
 * Reads facet.json and the asset files under srcDir, and writes a Claude
 * Code plugin directory to outDir. outDir is wiped and recreated first, so
 * it always reflects exactly the current source - nothing lingers from a
 * previous build. srcDir is never modified.
 */
export async function buildPlugin(srcDir: string, outDir: string): Promise<void> {
  const manifestPath = join(srcDir, "facet.json");
  const manifestText = await readSourceBody(manifestPath);
  const manifest = JSON.parse(manifestText) as FacetManifest;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const pluginManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: PLUGIN_AUTHOR,
  };
  await writeOutFile(
    join(outDir, ".claude-plugin", "plugin.json"),
    JSON.stringify(pluginManifest, null, 2) + "\n",
  );

  await emitSkills(srcDir, outDir, manifest.skills);
  await emitAgents(srcDir, outDir, manifest.agents);
  await emitCommands(srcDir, outDir, manifest.commands);
}

// CLI entry point. Only runs when this file is executed directly (`bun
// scripts/build-plugin.ts`), not when the test file imports buildPlugin.
if (import.meta.main) {
  const args = process.argv.slice(2);
  let outArg = "plugin";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      outArg = args[i + 1] ?? outArg;
      i++;
    }
  }
  const srcDir = process.cwd();
  const outDir = resolve(srcDir, outArg);
  await buildPlugin(srcDir, outDir);
}
