---
description: "Validate the current facet and build the distributable archive."
---

# Facet Build

Validate your facet configuration and generate a distributable artifact.

If the facet-studio MCP server is connected, run this operation through its `facet_build` tool instead of the shell — same behavior, structured result, branded panel where supported. Otherwise continue below.

## Validate configuration first

Run the validation check to catch errors before building:

```bash
facet build --verify --json
```

If validation fails, review the errors, fix your `facet.json`, and re-run the validation until it passes.

## Build the artifact

Once validation succeeds, build the complete package:

```bash
facet build --json
```

This writes your facet to `dist/<name>-<version>.facet`, where `<name>` and `<version>` come from `facet.json`.

## Verify the artifact

Your built facet file is in `dist/` and ready to publish.
