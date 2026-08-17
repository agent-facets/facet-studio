# Facet Remove

Uninstall one or more facets and clean up their assets.

## Task

Remove named facets from your project. This is destructive — it deletes installed assets and updates `facets.json` and `facets.lock`. Confirm before proceeding.

## Steps

1. Validate facet names. Each name must match `^(@[a-z](-?[a-z0-9])*/)?[a-z](-?[a-z0-9])*$` (alphanumeric with hyphens, optional scoped namespace); each part must be ≤ 64 chars. Refuse and stop if any name is invalid.

2. List what's currently installed:
   ```bash
   facet list
   ```

3. Show the user which facets will be removed. Ask for confirmation:
   ```
   Remove these facets? (yes/no)
   ```
   Stop if the user declines.

4. Remove the facets:
   ```bash
   facet remove '<name>' [<more>...]
   ```
   Or use the alias:
   ```bash
   facet rm '<name>' [<more>...]
   ```

5. Confirm removal by listing again:
   ```bash
   facet list
   ```
   Verify the removed facets are gone.

6. Remind the user:
   ```
   Commit your changes: git add facets.json facets.lock && git commit -m "Remove <names>"
   ```
