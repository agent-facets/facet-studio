# Facet Update

Move a facet to a newer version.

## Task

Update an installed facet to a different version. Updating is a re-add operation at the target version.

## Steps

1. **Show the current facets** to identify what you're updating:
   ```bash
   facet list
   ```

2. **Re-add the facet at the target version.** Specify the same facet name with a new version constraint:
   ```bash
   facet add '<name>@<new-version>'
   ```
   Examples: `facet add 'my-facet@2.0.0'`, `facet add 'my-facet@2.*'`.

3. **Confirm the update** by listing again:
   ```bash
   facet list
   ```

4. **If cloning elsewhere, use the frozen lockfile.** After adding or updating, anyone cloning the project can restore all facets exactly as installed:
   ```bash
   facet install --frozen-lockfile
   ```

5. **Commit both files.** Always commit the manifest and lockfile together:
   ```bash
   git add facets.json facets.lock
   git commit -m "Update facet: <name> to <new-version>"
   ```
