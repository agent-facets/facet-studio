# Facet Build

Build and validate a facet package. This command validates your facet configuration and generates a distributable artifact.

## Task

Validate your facet's configuration and create a build artifact (`.facet` file) in the `dist/` directory.

## Steps

1. **Validate your facet configuration**

   Run the validation check first to catch configuration errors before building:

   ```bash
   facet build --verify --json
   ```

   Review the output for any errors. If validation fails, fix your `facet.json` configuration and re-run validation.

2. **Build the facet artifact**

   Once validation passes, build the complete facet package:

   ```bash
   facet build --json
   ```

   This writes your facet to `dist/<name>-<version>.facet`, where `<name>` and `<version>` come from your `facet.json`.

3. **Locate your artifact**

   The built facet file is ready to publish or distribute. Note its full path in `dist/`.
