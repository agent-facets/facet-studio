---
description: "Update installed facets to newer versions."
---

# Facet Update

Move a facet to a newer version.

## Task

Update an installed facet to a different version. Updating is a re-add operation at the target version.

If the facet-studio MCP server is connected, run this operation through its `facet_update` tool instead of the shell — same behavior, structured result, branded panel where supported. Otherwise continue below.

## Steps

1. **Show the current facets** to identify what you're updating:
   ```bash
   facet list
   ```

2. **Validate the name and version before proceeding:**
   - The facet name (from `facet list`) must be valid: registry names (bare or scoped) must match `^(@[a-z](-?[a-z0-9])*/)?[a-z](-?[a-z0-9])*(@[0-9*][0-9A-Za-z.*-]*)?$`, with each name part ≤ 64 chars.
   - The version constraint can be a specific version (`2.0.0`), a minor range (`2.*`), or any matching semver.
   - Stop and explain the error if validation fails.

3. **Re-add the facet at the target version.** Specify the same facet name with a new version constraint:
   ```bash
   facet add '<name>@<new-version>'
   ```
   Examples: `facet add 'my-facet@2.0.0'`, `facet add 'my-facet@2.*'`.

4. **Confirm the update** by listing again:
   ```bash
   facet list
   ```

5. **If cloning elsewhere, use the frozen lockfile.** After adding or updating, anyone cloning the project can restore all facets exactly as installed:
   ```bash
   facet install --frozen-lockfile
   ```

6. **Commit both files.** Always commit the manifest and lockfile together:
   ```bash
   git add facets.json facets.lock
   git commit -m "Update facet: <name> to <new-version>"
   ```
