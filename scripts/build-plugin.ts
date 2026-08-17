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

import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, dirname, isAbsolute, parse as parsePath, relative, resolve } from "node:path";
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

// A companion file a skill ships alongside its SKILL.md, after both ends of the
// copy have been checked: where it is read from, and where it is written to.
interface Companion {
  sourcePath: string;
  outPath: string;
}

// One skill, agent, or command, with everything the emitters need already
// validated. Nothing below reaches back into the raw facet.json.
interface FacetAsset {
  name: string;
  description: string;
  files: Companion[];
}

interface FacetManifest {
  name: string;
  version: string;
  description: string;
  skills: FacetAsset[];
  agents: FacetAsset[];
  commands: FacetAsset[];
}

// ---------------------------------------------------------------------------
// Safety guards
//
// Two things here can be aimed at the wrong part of the filesystem: the output
// directory, which the build wipes before writing, and the paths a hand-edited
// facet.json names. Both are checked up front - before anything is deleted or
// written - so a build that is going to refuse refuses without doing damage.
// ---------------------------------------------------------------------------

// Asset names become directory and file names in both trees, so they have to
// stay plain identifiers: lowercase words joined by single hyphens. Anything
// else - a slash, a dot, a "..", a leading "/" - could aim a read or a write
// outside the source and output trees.
const ASSET_NAME_PATTERN = /^[a-z](-?[a-z0-9])*$/;
const ASSET_NAME_MAX_LENGTH = 64;

// If one of these sits directly inside a directory, that directory is somebody's
// source tree, not a build output, and wiping it would destroy real work.
const SOURCE_TREE_MARKERS = [".git", "facet.json"];

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a path down to what it really points at, symlinks and all, so two
 * different names for the same directory compare equal. A path that doesn't
 * exist yet is fine: the deepest part that does exist gets resolved and the
 * rest is appended, which still catches a symlinked parent.
 */
async function truePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await truePath(parent), basename(path));
  }
}

/** True when `child` is `parent` itself or sits somewhere beneath it. */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Refuses output directories that a build must never wipe.
 *
 * The build starts by deleting outDir, so pointing it at the source tree, at
 * anything containing the source tree, or at another checkout would erase
 * files nobody asked to lose. Symlinks are resolved first, so a link to the
 * source tree is caught as readily as the source tree's own name.
 *
 * `repoRoot` is injectable purely so tests can exercise the repo-root rule
 * against a scratch directory instead of the real repository.
 */
export async function assertSafeOutDir(
  srcDir: string,
  outDir: string,
  repoRoot: string = REPO_ROOT,
): Promise<void> {
  const src = await truePath(resolve(srcDir));
  const out = await truePath(resolve(outDir));
  const because = "and the build wipes its output directory before writing";

  if (out === src) {
    throw new Error(`refusing to build into ${out}: that is the facet source tree itself, ${because}`);
  }
  if (isWithin(out, src)) {
    throw new Error(`refusing to build into ${out}: it contains the facet source tree ${src}, ${because}`);
  }
  if (out === (await truePath(resolve(repoRoot)))) {
    throw new Error(`refusing to build into ${out}: that is this repository's root, ${because}`);
  }
  if (parsePath(out).root === out) {
    throw new Error(`refusing to build into ${out}: that is a filesystem root, ${because}`);
  }
  for (const marker of SOURCE_TREE_MARKERS) {
    if (await pathExists(join(out, marker))) {
      throw new Error(
        `refusing to build into ${out}: it holds a ${marker}, so it is a source tree rather than a generated output directory, ${because}`,
      );
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`facet.json: ${label} must be a non-empty string, got ${JSON.stringify(value) ?? typeof value}`);
  }
  return value;
}

function assertAssetName(kind: string, name: string): void {
  if (name.length > ASSET_NAME_MAX_LENGTH) {
    throw new Error(
      `facet.json declares a ${kind} named ${JSON.stringify(name)}: asset names may be at most ` +
        `${ASSET_NAME_MAX_LENGTH} characters, this one is ${name.length}`,
    );
  }
  if (!ASSET_NAME_PATTERN.test(name)) {
    throw new Error(
      `facet.json declares a ${kind} named ${JSON.stringify(name)}: asset names become file and directory ` +
        `names, so they must be lowercase words joined by single hyphens (${ASSET_NAME_PATTERN.source})`,
    );
  }
}

/**
 * Checks one asset and hands back the validated form the emitters use.
 *
 * `assetDir` is the directory the asset's own files live in - that's what a
 * declared companion path is relative to. A companion has to land inside the
 * source tree when read and inside the output tree when written; both absolute
 * paths are worked out here so nothing downstream re-derives them from the
 * manifest.
 */
async function validateAsset(
  kind: string,
  name: string,
  raw: unknown,
  srcReal: string,
  outDir: string,
  assetDir: string,
  outAssetDir: string,
): Promise<FacetAsset> {
  assertAssetName(kind, name);

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`facet.json: ${kind} ${JSON.stringify(name)} must be an object with a description`);
  }
  const asset = raw as { description?: unknown; files?: unknown };
  const description = requireString(asset.description, `${kind} ${JSON.stringify(name)} description`);

  const declared = asset.files ?? [];
  if (!Array.isArray(declared)) {
    throw new Error(`facet.json: ${kind} ${JSON.stringify(name)} "files" must be an array of paths`);
  }

  const files: Companion[] = [];
  for (const [index, entry] of declared.entries()) {
    const relPath = requireString(entry, `${kind} ${JSON.stringify(name)} files[${index}]`);

    const sourcePath = await truePath(resolve(assetDir, relPath));
    if (!isWithin(srcReal, sourcePath) || sourcePath === srcReal) {
      throw new Error(
        `facet.json: ${kind} ${JSON.stringify(name)} declares the file ${JSON.stringify(relPath)}, which ` +
          `resolves to ${sourcePath} - outside the facet source tree ${srcReal}`,
      );
    }

    const outPath = resolve(outAssetDir, relPath);
    if (!isWithin(outDir, outPath) || outPath === outDir) {
      throw new Error(
        `facet.json: ${kind} ${JSON.stringify(name)} declares the file ${JSON.stringify(relPath)}, which ` +
          `would be written to ${outPath} - outside the output directory ${outDir}`,
      );
    }

    files.push({ sourcePath, outPath });
  }

  return { name, description, files };
}

/**
 * Turns the parsed facet.json into a manifest the rest of the build can trust.
 *
 * facet.json is hand-edited, so every value that ends up in a path or in
 * emitted frontmatter is checked here rather than assumed. Unrecognized keys
 * are left alone - this validates what the build actually uses.
 */
async function validateManifest(raw: unknown, srcDir: string, outDir: string): Promise<FacetManifest> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("facet.json: expected a JSON object");
  }
  const manifest = raw as Record<string, unknown>;
  const srcReal = await truePath(srcDir);

  async function assetsOf(kind: "skills" | "agents" | "commands"): Promise<FacetAsset[]> {
    const declared = manifest[kind] ?? {};
    if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
      throw new Error(`facet.json: "${kind}" must be an object keyed by asset name`);
    }
    const singular = kind.slice(0, -1);
    const validated: FacetAsset[] = [];
    for (const [name, asset] of Object.entries(declared as Record<string, unknown>)) {
      // Skills own a directory each; agents and commands are single files that
      // sit directly in their kind's directory.
      const assetDir = kind === "skills" ? join(srcDir, kind, name) : join(srcDir, kind);
      const outAssetDir = kind === "skills" ? join(outDir, kind, name) : join(outDir, kind);
      validated.push(
        await validateAsset(singular, name, asset, srcReal, outDir, assetDir, outAssetDir),
      );
    }
    return validated;
  }

  return {
    name: requireString(manifest.name, "name"),
    version: requireString(manifest.version, "version"),
    description: requireString(manifest.description, "description"),
    skills: await assetsOf("skills"),
    agents: await assetsOf("agents"),
    commands: await assetsOf("commands"),
  };
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

async function emitSkills(srcDir: string, outDir: string, skills: FacetAsset[]): Promise<void> {
  for (const skill of skills) {
    const srcPath = join(srcDir, "skills", skill.name, "SKILL.md");
    const body = await readSourceBody(srcPath);
    const frontmatter = renderFrontmatter([
      ["name", skill.name],
      ["description", skill.description],
    ]);
    await writeOutFile(join(outDir, "skills", skill.name, "SKILL.md"), frontmatter + body);

    // Both paths were checked against the source and output trees when the
    // manifest was validated, so the copy uses them as-is.
    for (const companion of skill.files) {
      const source = Bun.file(companion.sourcePath);
      if (!(await source.exists())) {
        throw new Error(`missing companion file: ${companion.sourcePath}`);
      }
      await mkdir(dirname(companion.outPath), { recursive: true });
      await Bun.write(companion.outPath, await source.arrayBuffer());
    }
  }
}

async function emitAgents(srcDir: string, outDir: string, agents: FacetAsset[]): Promise<void> {
  for (const agent of agents) {
    const srcPath = join(srcDir, "agents", `${agent.name}.md`);
    const body = await readSourceBody(srcPath);
    const frontmatter = renderFrontmatter([
      ["name", agent.name],
      ["description", agent.description],
    ]);
    await writeOutFile(join(outDir, "agents", `${agent.name}.md`), frontmatter + body);
  }
}

async function emitCommands(srcDir: string, outDir: string, commands: FacetAsset[]): Promise<void> {
  for (const command of commands) {
    const srcPath = join(srcDir, "commands", `${command.name}.md`);
    const body = await readSourceBody(srcPath);
    const frontmatter = renderFrontmatter([["description", command.description]]);
    await writeOutFile(join(outDir, "commands", `${command.name}.md`), frontmatter + body);
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
 *
 * Because that wipe is destructive, and because facet.json is hand-edited,
 * both the output directory and every path the manifest names are checked
 * before a single file is deleted or written. A build that refuses leaves the
 * filesystem exactly as it found it.
 */
export async function buildPlugin(srcDir: string, outDir: string): Promise<void> {
  const src = resolve(srcDir);
  const out = resolve(outDir);

  const manifestPath = join(src, "facet.json");
  const manifestText = await readSourceBody(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${(error as Error).message}`);
  }

  await assertSafeOutDir(src, out);
  const manifest = await validateManifest(parsed, src, out);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // A facet with an MCP server is recognized by having one: there is no switch
  // in facet.json to forget to flip.
  const hasMcpServer = await Bun.file(join(src, MCP_ENTRY)).exists();
  if (hasMcpServer) {
    await bundleMcpServer(src, out);
  }

  const pluginManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: PLUGIN_AUTHOR,
    ...(hasMcpServer ? { mcpServers: { [manifest.name]: MCP_LAUNCH } } : {}),
  };
  await writeOutFile(
    join(out, ".claude-plugin", "plugin.json"),
    JSON.stringify(pluginManifest, null, 2) + "\n",
  );

  await emitSkills(src, out, manifest.skills);
  await emitAgents(src, out, manifest.agents);
  await emitCommands(src, out, manifest.commands);
}

// CLI entry point. Only runs when this file is executed directly (`bun
// scripts/build-plugin.ts`), not when the test file imports buildPlugin.
if (import.meta.main) {
  const args = process.argv.slice(2);
  let outArg = "plugin";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      // A bare trailing `--out` used to fall back to the default silently,
      // which is a nasty way to wipe a directory the caller never named.
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error("--out needs a directory to build into");
      }
      outArg = value;
      i++;
    }
  }
  const srcDir = process.cwd();
  const outDir = resolve(srcDir, outArg);
  await buildPlugin(srcDir, outDir);
}
