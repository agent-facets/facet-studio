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

import { lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, dirname, isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_AUTHOR = { name: "James Dunnam" };

// The repo this script lives in, so build inputs can be named by their repo
// path instead of relative to whatever directory the caller started in.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The facet's MCP server source, and where its bundle lands in the plugin.
const MCP_ENTRY = join("mcp", "src", "server.ts");
const MCP_BUNDLE = join("mcp", "server.mjs");

// The shell launcher that starts the bundle, copied in beside it.
const MCP_LAUNCHER = join("mcp", "launch.sh");

// How Claude Code is told to launch the server. `${CLAUDE_PLUGIN_ROOT}` is
// substituted by the plugin loader with wherever the plugin was installed, so
// this stays a literal string here - it is not a template we fill in.
//
// The launcher runs instead of `node` directly because GUI hosts start plugins
// from launchd, with none of the user's shell profile: a version-managed Node
// is invisible there and the server never starts. launch.sh recovers the real
// PATH first. `/bin/sh` is spelled absolutely for the same reason - the PATH we
// are handed is the thing we cannot trust. It is also why the launcher needs no
// executable bit: sh is given the script to read, not asked to run it.
// `${CLAUDE_PROJECT_DIR}` is the other half of the same problem: the host
// starts the server wherever it likes, so the working directory says nothing
// about where the user's project is. Claude Code substitutes this one for MCP
// subprocesses, which turns the root from a guess into something we were told.
const MCP_LAUNCH = {
  command: "/bin/sh",
  args: ["${CLAUDE_PLUGIN_ROOT}/mcp/launch.sh"],
  env: { FACET_PROJECT_ROOT: "${CLAUDE_PROJECT_DIR}" },
};

// One file to copy, after both ends have been checked: where it is read from,
// and where it is written to.
interface CheckedFile {
  sourcePath: string;
  outPath: string;
}

// One skill, agent, or command, with everything the emitters need already
// validated. `body` is the asset's own markdown - a skill's SKILL.md, an
// agent's or command's <name>.md - and `files` are the extras a skill ships
// alongside it. Nothing below reaches back into the raw facet.json.
interface FacetAsset {
  name: string;
  description: string;
  body: CheckedFile;
  files: CheckedFile[];
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
// directory, which the build clears before writing, and the paths a hand-edited
// facet.json names. Both are checked up front - before anything is deleted or
// written - so a build that is going to refuse refuses without doing damage.
// And the clearing itself is as narrow as it can be: a build removes the exact
// files the last build recorded having written, so even a directory we were
// wrong to accept keeps everything else it holds.
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

// A little label every build drops at the top of its output, so somebody who
// opens the directory can see what it is. It is written by the generator and
// never edited by hand. It says nothing about what may be deleted - that is the
// file list's job, below.
export const OUTPUT_MARKER = ".facet-plugin-output";
const OUTPUT_MARKER_BODY =
  "Generated by facet build-plugin.\n" +
  "Every file here was written from the facet source; the list beside this one\n" +
  "(.facet-plugin-manifest) records exactly which. The next build replaces those\n" +
  "files and leaves everything else in this directory alone.\n";

// The marker's first line. Anyone can create a file with the marker's name, so
// a build only treats one as its own when it is a plain file that opens with
// the text a build would have written. This line is printed into every plugin
// this generator has ever built, so it is public knowledge and trivially
// copied - which is precisely why nothing destructive hangs off it.
const OUTPUT_MARKER_SIGNATURE = "Generated by facet build-plugin.";

// The list of every file a build wrote, dropped in the output beside the marker
// so the next build knows what to take away. Rebuilding removes exactly the
// paths named here and nothing else, so a file the generator never wrote - even
// one sitting deep inside a directory it did write - is never at risk.
export const OUTPUT_MANIFEST = ".facet-plugin-manifest";

// What the file list says about itself, so a same-named file from something
// else is not mistaken for one of ours.
const OUTPUT_MANIFEST_GENERATOR = "facet build-plugin";

// Names a build may leave at the top of its output. This is only used to
// recognize a plugin directory built before the marker existed; it is not a
// deletion list, and nothing is removed for merely having one of these names.
const GENERATED_TOP_LEVEL = [
  OUTPUT_MARKER,
  OUTPUT_MANIFEST,
  ".claude-plugin",
  "skills",
  "agents",
  "commands",
  "mcp",
];
const IS_GENERATED_TOP_LEVEL = new Set(GENERATED_TOP_LEVEL);

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
 * Did a build write this marker, or does the file just have the right name?
 *
 * Presence alone proves nothing - a name is trivial to forge, and a directory
 * or a symlink called `.facet-plugin-output` is not a marker at all. So the
 * marker only counts when it is a plain file opening with the line a build
 * would have written.
 */
async function markerLooksGenerated(out: string): Promise<boolean> {
  const path = join(out, OUTPUT_MARKER);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  try {
    return (await Bun.file(path).text()).startsWith(OUTPUT_MARKER_SIGNATURE);
  } catch {
    return false;
  }
}

/**
 * Looks at whatever is already sitting at the output path and says why the
 * build must keep its hands off it - or hands back null when it is safe to
 * build here.
 *
 * The name-based guards above only catch a directory that *is* the source tree
 * or sits above it. They say nothing about a directory tucked inside it, and
 * `--out skills` is exactly that: a perfectly ordinary-looking path full of
 * files the build would go on to replace. Since the normal output (`plugin/`)
 * is nested too, nesting can't be the test. What the target holds can:
 *
 *   - nothing there yet, or an empty directory - safe, nothing can be lost;
 *   - a readable list of the files the last build wrote - certainly one of ours;
 *   - a marker a build actually wrote - looks like one of ours to rebuild;
 *   - a plugin manifest and nothing at the top level we don't emit - also one
 *     of ours, from before any of this existed;
 *   - anything else - somebody's files. Refuse.
 *
 * Passing this check is permission to *build here*, and nothing more. It is not
 * permission to delete what is lying around: a rebuild removes only the paths
 * the last build wrote down (see removeRecordedOutput), so the two weaker
 * signals here - a marker anyone could copy, a familiar-looking directory
 * layout - cost nobody a file even when they are wrong.
 */
async function whyOutDirMustSurvive(out: string): Promise<string | null> {
  let stats;
  try {
    stats = await lstat(out);
  } catch {
    return null; // Nothing there; the build creates it.
  }
  if (!stats.isDirectory()) {
    return "it is not a directory, so building here would delete it";
  }

  const entries = await readdir(out);
  if (entries.length === 0) return null;
  if ((await readRecordedOutput(out)) !== null) return null;
  if (await markerLooksGenerated(out)) return null;

  const strays = entries.filter((entry) => !IS_GENERATED_TOP_LEVEL.has(entry)).sort();
  if (strays.length === 0 && (await pathExists(join(out, ".claude-plugin", "plugin.json")))) {
    return null; // A plugin directory this generator built before it left markers.
  }

  const named = (strays.length > 0 ? strays : entries.sort()).slice(0, 3).map((e) => JSON.stringify(e));
  const andMore = entries.length > named.length ? ", ..." : "";
  return (
    `it already holds files this build did not generate (${named.join(", ")}${andMore}), ` +
    `so it is somebody's directory rather than a generated output directory`
  );
}

/**
 * Refuses output directories a build must never touch.
 *
 * The build clears its own output before writing, so pointing it at the source
 * tree, at anything containing the source tree, at another checkout, or at any
 * directory that already holds files this generator didn't write would erase
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

  const occupied = await whyOutDirMustSurvive(out);
  if (occupied !== null) {
    throw new Error(`refusing to build into ${out}: ${occupied}, ${because}`);
  }
}

/**
 * Turns an absolute path under the output directory into the form the file list
 * stores: a relative path with forward slashes, so the list reads the same on
 * any platform.
 */
function toRecordedPath(out: string, path: string): string {
  return relative(out, path).split(sep).join("/");
}

/** The other direction: a recorded path back to somewhere on this machine. */
function fromRecordedPath(out: string, recorded: string): string {
  return join(out, ...recorded.split("/"));
}

/**
 * Is this something the file list is allowed to name? Only a plain relative
 * path pointing at something inside the output directory - no absolute paths,
 * no `..`, no empty segments, and not the output directory itself.
 */
function isRecordablePath(out: string, recorded: unknown): recorded is string {
  if (typeof recorded !== "string" || recorded === "" || isAbsolute(recorded)) return false;
  const segments = recorded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const path = fromRecordedPath(out, recorded);
  return isWithin(out, path) && path !== out;
}

/**
 * Reads the list of files the last build wrote, or hands back null when there
 * isn't one to trust.
 *
 * Null covers every doubtful case: no list, a list that is a directory or a
 * symlink, unparseable JSON, a list some other tool wrote, or one naming a path
 * that reaches outside the output directory. One bad entry discards the whole
 * list rather than just that entry - a list that has been tampered with says
 * nothing reliable about the rest of its contents.
 *
 * Null means "delete nothing". It never means "delete everything": a build with
 * no record to go by writes its own files over whatever is there and leaves the
 * rest of the directory alone, which can leave an old build's files behind but
 * can never take somebody else's away.
 */
async function readRecordedOutput(out: string): Promise<string[] | null> {
  const path = join(out, OUTPUT_MANIFEST);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as { generator?: unknown; paths?: unknown };
  if (record.generator !== OUTPUT_MANIFEST_GENERATOR) return null;
  if (!Array.isArray(record.paths)) return null;
  if (!record.paths.every((entry) => isRecordablePath(out, entry))) return null;
  return record.paths as string[];
}

/** The file list itself: sorted, so the same source always writes the same bytes. */
function renderRecordedOutput(paths: string[]): string {
  const record = { generator: OUTPUT_MANIFEST_GENERATOR, paths: [...paths].sort() };
  return JSON.stringify(record, null, 2) + "\n";
}

/**
 * Checks that a path the build is about to write to, or remove, really is
 * inside the output directory - and refuses if reaching it would mean going
 * through a symlink.
 *
 * `lstat` only looks at the last part of a path, so without walking the whole
 * chain a link swapped in for `skills/` would quietly send both the writes and
 * the deletions somewhere else. Nothing here changes anything on disk; it is
 * called for every path before the first one is touched.
 */
async function assertReachableWithoutLinks(out: string, recorded: string): Promise<void> {
  const segments = recorded.split("/");
  let path = out;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      return; // Nothing there yet, so there is nothing to follow or clobber.
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `refusing to build into ${out}: ${path} is a symlink, and this build has to write ${recorded} ` +
          `itself - following it would write through the link, outside the output directory`,
      );
    }
    const last = index === segments.length - 1;
    if (!last && !stats.isDirectory()) {
      throw new Error(
        `refusing to build into ${out}: ${path} is not a directory, and this build has to write ` +
          `${recorded} underneath it`,
      );
    }
    if (last && !stats.isFile() && !stats.isDirectory()) {
      throw new Error(
        `refusing to build into ${out}: ${path} is neither a regular file nor a directory, and this ` +
          `build has to write ${recorded} itself - it will not remove something it did not create`,
      );
    }
  }
}

/**
 * Removes the files the last build recorded writing, and only those.
 *
 * The build used to delete whole directories by name, which meant a file
 * somebody had tucked inside `skills/` went with them - and one misjudgement
 * about whether the directory was "ours" was enough to lose it. There is no
 * judgement left to make here: the previous build wrote down what it created,
 * and this takes those exact paths away. Files go first, then the directories
 * they lived in, and only while those come away empty - a directory still
 * holding anything at all stays, with its contents.
 *
 * Everything is checked before anything is removed, so a build that is going to
 * refuse refuses with the directory untouched.
 */
async function removeRecordedOutput(out: string, recorded: string[]): Promise<void> {
  const doomed: string[] = [];
  const parents = new Set<string>();

  for (const entry of recorded) {
    const path = fromRecordedPath(out, entry);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      continue; // Already gone.
    }
    if (stats.isDirectory()) {
      throw new Error(
        `refusing to build into ${out}: ${path} was recorded as a file the last build wrote, but a ` +
          `directory stands there now - this build will not remove a directory it did not create`,
      );
    }
    doomed.push(path);
    const segments = entry.split("/");
    for (let depth = segments.length - 1; depth > 0; depth--) {
      parents.add(segments.slice(0, depth).join("/"));
    }
  }

  for (const path of doomed) {
    await rm(path, { force: true });
  }

  // Deepest first, so a directory tree the build no longer emits comes away
  // from the bottom up. rmdir refuses a directory that still holds something,
  // and that refusal is the point: whatever is in there isn't ours.
  const deepestFirst = [...parents].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const entry of deepestFirst) {
    try {
      await rmdir(fromRecordedPath(out, entry));
    } catch {
      // Not empty, or not there. Either way it stays.
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
 * Works out where one file is read from and written to, and refuses it if
 * either end lands outside the tree it belongs in.
 *
 * The read side is resolved through symlinks first, so a link out of the source
 * tree is caught rather than followed - it makes no difference whether the link
 * is the file itself or a directory somewhere above it. `what` describes the
 * file the way the error message needs to name it.
 */
async function checkFilePaths(
  what: string,
  relPath: string,
  srcReal: string,
  outDir: string,
  assetDir: string,
  outAssetDir: string,
): Promise<CheckedFile> {
  const sourcePath = await truePath(resolve(assetDir, relPath));
  if (!isWithin(srcReal, sourcePath) || sourcePath === srcReal) {
    throw new Error(
      `facet.json: ${what}, which resolves to ${sourcePath} - outside the facet source tree ${srcReal}`,
    );
  }

  const outPath = resolve(outAssetDir, relPath);
  if (!isWithin(outDir, outPath) || outPath === outDir) {
    throw new Error(
      `facet.json: ${what}, which would be written to ${outPath} - outside the output directory ${outDir}`,
    );
  }

  return { sourcePath, outPath };
}

/**
 * Checks one asset and hands back the validated form the emitters use.
 *
 * `assetDir` is the directory the asset's own files live in - that's what its
 * markdown and any declared companion path are relative to. Every file gets the
 * same treatment: it has to land inside the source tree when read and inside
 * the output tree when written. The asset's own markdown is checked here too,
 * not just the companions, because a skill directory can perfectly well be a
 * symlink pointing at somebody else's files. Both absolute paths are worked out
 * here so nothing downstream re-derives them from the manifest.
 */
async function validateAsset(
  kind: string,
  name: string,
  bodyFile: string,
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

  const body = await checkFilePaths(
    `${kind} ${JSON.stringify(name)} takes its body from ${JSON.stringify(bodyFile)}`,
    bodyFile,
    srcReal,
    outDir,
    assetDir,
    outAssetDir,
  );

  const declared = asset.files ?? [];
  if (!Array.isArray(declared)) {
    throw new Error(`facet.json: ${kind} ${JSON.stringify(name)} "files" must be an array of paths`);
  }

  const files: CheckedFile[] = [];
  for (const [index, entry] of declared.entries()) {
    const relPath = requireString(entry, `${kind} ${JSON.stringify(name)} files[${index}]`);
    files.push(
      await checkFilePaths(
        `${kind} ${JSON.stringify(name)} declares the file ${JSON.stringify(relPath)}`,
        relPath,
        srcReal,
        outDir,
        assetDir,
        outAssetDir,
      ),
    );
  }

  return { name, description, body, files };
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
      // Skills own a directory each and keep their markdown in SKILL.md; agents
      // and commands are single <name>.md files sitting directly in their
      // kind's directory. These are only strings until validateAsset has passed
      // the name through the grammar check, and nothing is read before that.
      const ownsDirectory = kind === "skills";
      const assetDir = ownsDirectory ? join(srcDir, kind, name) : join(srcDir, kind);
      const outAssetDir = ownsDirectory ? join(outDir, kind, name) : join(outDir, kind);
      const bodyFile = ownsDirectory ? "SKILL.md" : `${name}.md`;
      validated.push(
        await validateAsset(singular, name, bodyFile, asset, srcReal, outDir, assetDir, outAssetDir),
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

// Every path below comes from the validated manifest, where both ends were
// already checked against the source and output trees. Nothing here rebuilds a
// path out of an asset's name - doing that is how the SKILL.md read used to
// escape the source tree through a symlinked skill directory.
async function emitSkills(skills: FacetAsset[]): Promise<void> {
  for (const skill of skills) {
    const body = await readSourceBody(skill.body.sourcePath);
    const frontmatter = renderFrontmatter([
      ["name", skill.name],
      ["description", skill.description],
    ]);
    await writeOutFile(skill.body.outPath, frontmatter + body);

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

async function emitAgents(agents: FacetAsset[]): Promise<void> {
  for (const agent of agents) {
    const body = await readSourceBody(agent.body.sourcePath);
    const frontmatter = renderFrontmatter([
      ["name", agent.name],
      ["description", agent.description],
    ]);
    await writeOutFile(agent.body.outPath, frontmatter + body);
  }
}

async function emitCommands(commands: FacetAsset[]): Promise<void> {
  for (const command of commands) {
    const body = await readSourceBody(command.body.sourcePath);
    const frontmatter = renderFrontmatter([["description", command.description]]);
    await writeOutFile(command.body.outPath, frontmatter + body);
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

  // The launcher goes in beside the bundle. It is copied verbatim rather than
  // generated, so the shipped file is the one that can be read and tested in
  // the source tree.
  const launcher = Bun.file(join(srcDir, MCP_LAUNCHER));
  if (!(await launcher.exists())) {
    throw new Error(`no MCP launcher at ${MCP_LAUNCHER}; plugin.json would point at a file that isn't there`);
  }
  await Bun.write(join(outDir, MCP_LAUNCHER), await launcher.arrayBuffer());
}

/**
 * Every file this build is going to write, as paths relative to the output
 * directory. Working this out up front is what lets the build check all of them
 * before it touches anything, and what goes into the file list it leaves behind
 * for the next build to clean up.
 */
function pathsToEmit(out: string, manifest: FacetManifest, hasMcpServer: boolean): string[] {
  const paths = [OUTPUT_MARKER, OUTPUT_MANIFEST, join(".claude-plugin", "plugin.json")];
  if (hasMcpServer) paths.push(MCP_BUNDLE, MCP_LAUNCHER);
  for (const asset of [...manifest.skills, ...manifest.agents, ...manifest.commands]) {
    paths.push(asset.body.outPath, ...asset.files.map((file) => file.outPath));
  }
  const recorded = [...new Set(paths.map((path) => toRecordedPath(out, resolve(out, path))))].sort();
  for (const path of recorded) {
    // Every one of these was checked against the output tree on the way in, so
    // this is a backstop rather than a real possibility: nothing gets written
    // down that a later build would then be entitled to delete from elsewhere.
    if (!isRecordablePath(out, path)) {
      throw new Error(`refusing to build into ${out}: ${path} would be written outside the output directory`);
    }
  }
  return recorded;
}

/**
 * Reads facet.json and the asset files under srcDir, and writes a Claude
 * Code plugin directory to outDir. The files the previous build recorded
 * writing are removed first, so the output always reflects exactly the current
 * source - nothing lingers from a previous build. Files the generator never
 * wrote are left alone, and srcDir is never modified.
 *
 * Because clearing is destructive, and because facet.json is hand-edited, both
 * the output directory and every path the manifest names are checked before a
 * single file is deleted or written. A build that refuses leaves the filesystem
 * exactly as it found it.
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

  // A facet with an MCP server is recognized by having one: there is no switch
  // in facet.json to forget to flip.
  const hasMcpServer = await Bun.file(join(src, MCP_ENTRY)).exists();

  const emitting = pathsToEmit(out, manifest, hasMcpServer);
  const recorded = (await readRecordedOutput(out)) ?? [];

  // Every path this build will remove or write, checked before the first one is
  // touched, so a build that is going to refuse refuses without doing damage.
  for (const path of new Set([...recorded, ...emitting])) {
    await assertReachableWithoutLinks(out, path);
  }

  await removeRecordedOutput(out, recorded);
  await mkdir(out, { recursive: true });

  // Claim the directory before anything else goes into it, so that even a build
  // that dies partway through leaves a label and a complete list of what it was
  // going to write - which is what lets the next build clear up after it.
  await Bun.write(join(out, OUTPUT_MARKER), OUTPUT_MARKER_BODY);
  await Bun.write(join(out, OUTPUT_MANIFEST), renderRecordedOutput(emitting));

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

  await emitSkills(manifest.skills);
  await emitAgents(manifest.agents);
  await emitCommands(manifest.commands);
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
