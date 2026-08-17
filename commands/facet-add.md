# Facet Add

Install a facet into the current project from the registry, a git repository, or a local path.

## Task

Add a facet by name, version, or source. The source can be a registry entry, a GitHub repository, or a local path within the project. Facet sources are validated before use to prevent shell injection.

## Steps

1. **Identify the facet source.** It can be:
   - A registry name: `my-facet` or `my-facet@1.2.3` or `my-facet@1.*`
   - A scoped registry name: `@namespace/my-facet@1.2.3`
   - A GitHub repository: `github:owner/repo#ref`
   - A local path inside the project: `./path/to/facet`

2. **Validate the source** before proceeding:
   - Registry names (bare or scoped): must match `^(@[a-z](-?[a-z0-9])*/)?[a-z](-?[a-z0-9])*(@[0-9*][0-9A-Za-z.*-]*)?$`, each name part ≤ 64 chars. Refuse if invalid.
   - GitHub sources: must start with `github:`. Refuse if it doesn't.
   - Local paths: must start with `./`. Refuse if it doesn't, and verify the path is inside the project tree.
   - Stop and explain the error if validation fails.

3. **Run facet add.** If the CLI says you need an adapter, install one:
   ```bash
   facet add '<source>'
   ```
   If this fails with "no adapter installed", install the Claude Code adapter:
   ```bash
   facet adapter add claude-code
   ```
   Then retry `facet add '<source>'`.

4. **Confirm the installation** by listing all facets:
   ```bash
   facet list
   ```

5. **Handle name collisions.** If the CLI prints an alias suggestion (a copy-pasteable fix), relay it exactly as printed. Do not improvise.

6. **Commit the lockfile and manifest.** After a successful add, always commit:
   ```bash
   git add facets.json facets.lock
   git commit -m "Add facet: <name>"
   ```
