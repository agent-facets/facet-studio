// Turns a facet source tree into a Claude Code plugin directory.
//
// A facet ships one source of truth (facet.json + skills/agents/commands
// markdown files). This script reads that source and emits the parallel
// layout Claude Code's plugin loader expects: a .claude-plugin/plugin.json
// manifest plus per-asset markdown files with YAML frontmatter. It never
// writes back into the source tree, and running it twice on the same input
// must produce byte-identical output (no timestamps, no random ids).
//
// When the facet carries an MCP server (mcp/src/server.ts), the server is
// bundled into the plugin as a single self-contained file and declared in
// plugin.json, so installing the plugin is all a user has to do - nothing is
// fetched from npm at run time.

import { mkdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

const PLUGIN_AUTHOR = { name: "James Dunnam" };

// The facet's MCP server source, and where its bundle lands in the plugin.
const MCP_ENTRY = join("mcp", "src", "server.ts");
const MCP_BUNDLE = join("mcp", "server.mjs");

// How Claude Code is told to launch the server. `${CLAUDE_PLUGIN_ROOT}` is
// substituted by the plugin loader with wherever the plugin was installed, so
// this stays a literal string here - it is not a template we fill in.
const MCP_LAUNCH = { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"] };

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
 * Bundles the facet's MCP server into the plugin output as one standalone
 * file: every dependency is inlined, so the installed plugin needs nothing
 * from npm and no node_modules directory of its own.
 *
 * The bundler runs as a plain argument list - no shell is involved anywhere,
 * so a directory name with a space or a quote in it is just a name. It writes
 * only into outDir; the source tree is read-only here as everywhere else.
 *
 * Throws if the bundler fails or produces an empty file. That is deliberate:
 * plugin.json is written after this, so a build either ships a real server or
 * it ships no declaration at all - never a declaration pointing at a file that
 * isn't there (which plugin validation does not catch).
 */
async function bundleMcpServer(srcDir: string, outDir: string): Promise<void> {
  // The bundler creates the directories it needs, so a failed build leaves the
  // output directory empty rather than half-populated.
  const outFile = join(outDir, MCP_BUNDLE);

  // process.execPath is the Bun that is running this script, so the build uses
  // the same toolchain the caller invoked rather than whatever `bun` happens to
  // be first on PATH.
  const result = Bun.spawnSync(
    [process.execPath, "build", MCP_ENTRY, "--target=node", "--outfile", outFile],
    { cwd: srcDir, stdout: "pipe", stderr: "pipe" },
  );
  if (!result.success) {
    const details = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`failed to bundle ${MCP_ENTRY} (exit ${result.exitCode}):\n${details}`);
  }

  const bundle = Bun.file(outFile);
  if (!(await bundle.exists()) || bundle.size === 0) {
    throw new Error(`bundling ${MCP_ENTRY} reported success but wrote no bundle at ${outFile}`);
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

  // A facet with an MCP server is recognized by having one: there is no switch
  // in facet.json to forget to flip.
  const hasMcpServer = await Bun.file(join(srcDir, MCP_ENTRY)).exists();
  if (hasMcpServer) {
    await bundleMcpServer(srcDir, outDir);
  }

  const pluginManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: PLUGIN_AUTHOR,
    ...(hasMcpServer ? { mcpServers: { [manifest.name]: MCP_LAUNCH } } : {}),
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
