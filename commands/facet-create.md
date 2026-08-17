# facet-create

Scaffold a new facet with skills, agents, or commands.

## Gather input

Prompt the user for:
- **Facet name** (e.g., `my-facet` or `@myorg/my-facet`)
- **Description** (e.g., `Does X with Y`)
- **Assets** (at least one; comma-separated list of skill/agent/command names)
- **Version** (optional; defaults to `0.1.0`)
- **Privacy flag** (optional; `--private` if requested)

## Validate names

Before passing any value to the shell, validate:

1. **Facet name:** must match `^[a-z](-?[a-z0-9])*$` (scope `@scope/name` also allowed, each part validated separately) and be ≤ 64 chars total.
2. **Each skill/agent/command name:** must match `^[a-z](-?[a-z0-9])*$` and be ≤ 64 chars.

If any name fails, print the grammar rule and **stop**—do not proceed to the command.

## Check assets

If no skills, agents, or commands are listed, tell the user "no assets to scaffold" and **stop**.

## Create the facet

Run:

```bash
facet create . --name '<name>' \
  --description '<description>' \
  [--version <version>] [--private] \
  [--skill '<s>']... [--agent '<a>']... [--command '<c>']... \
  --no-readme --json
```

Print the JSON response (the created facet tree and asset list). If the facet exists, the command exits 1; offer `--force` **only with explicit user consent** and remind them to review the existing facet.json.

## Next: customize your assets

Use `facet modify` to add descriptions, rename assets, or adjust versions. Edit `facet.json` for build settings and asset content.
