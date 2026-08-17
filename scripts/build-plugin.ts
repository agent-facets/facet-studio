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
//
// One export here is not part of that pipeline: compileBrowserScript, which
// the MCP server imports as a build-time macro to inline its panel view. It
// lives with the rest of the build tooling because that is what it is.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_AUTHOR = { name: "James Dunnam" };

// The repo this script lives in, so build inputs can be named by their repo
// path instead of relative to whatever directory the caller started in.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
 * Compiles a browser module into one self-contained script and hands it back
 * as a string. Nothing is written to disk.
 *
 * This is the odd one out in this file: it emits no file, and the caller isn't
 * the generator below but the MCP server's own source, which imports it as a
 * Bun macro (see mcp/src/server.ts). That means the compiled script is baked
 * into the server the moment the server is transpiled or bundled — the panel
 * carries its view whether the server is run from source or shipped as a
 * single bundled file, with nothing to locate or fetch at run time.
 *
 * It lives here rather than beside the panel because of a Bun rule: a macro
 * cannot be imported from a module that pulls in the MCP Apps SDK, whose
 * bundled `require` shim throws inside the macro sandbox. Build tooling is the
 * next best home, and this is the build tooling.
 *
 * `entry` is a repo-relative path. The build starts from a one-line generated
 * entry that imports it purely for its side effects, so the bundler can drop
 * every export the browser never touches — for the panel that means leaving
 * the server SDK and the HTML shell out of a script meant for an iframe.
 * Minified output carries no file-path comments, so the same source produces
 * the same bytes in any checkout, which is what keeps plugin builds
 * reproducible.
 */
export async function compileBrowserScript(entry: string, banner: string): Promise<string> {
  const entryPath = resolve(REPO_ROOT, entry);

  // The bundler runs as a plain argument list, and the generated entry names
  // its target as an absolute path, so nothing here depends on the current
  // directory or goes anywhere near a shell. Macros aren't allowed to call
  // Bun.build in-process, hence the CLI.
  const scratch = await mkdtemp(join(tmpdir(), "facet-browser-build-"));
  try {
    const generatedEntry = join(scratch, "entry.ts");
    await Bun.write(generatedEntry, `import ${JSON.stringify(entryPath)};\n`);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "build",
        generatedEntry,
        "--target=browser",
        "--format=esm",
        "--minify",
        `--banner=${banner}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (!result.success) {
      const details = result.stderr.toString().trim() || result.stdout.toString().trim();
      throw new Error(`failed to compile ${entry} for the browser (exit ${result.exitCode}):\n${details}`);
    }

    const script = result.stdout.toString();
    if (script.trim() === "") {
      throw new Error(`compiling ${entry} for the browser reported success but produced no script`);
    }
    return script;
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
