Validate your facet configuration and generate a distributable artifact.

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
