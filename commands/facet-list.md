# Facet List

List all installed facets in your project.

## Task

Print the names and versions of every facet declared in `facets.json`. This is read-only — it does not modify files.

## Steps

1. Run the list command:
   ```bash
   facet list
   ```

2. Review the output. Each line shows a facet's name and version. If the list looks wrong or incomplete, your `facets.json` may be out of sync with installed assets — run `facet install` to repair drift.
