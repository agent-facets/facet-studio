# Facet Publish

Publish your facet package to the registry. Published facets are immutable—once a version is released, it cannot be modified. Plan your changes carefully before publishing.

## Task

Authenticate to the registry, confirm your identity, validate your build is current, and publish your facet package.

## Steps

1. **Verify your registry identity**

   Check that you are authenticated and confirm your identity:

   ```bash
   facet whoami
   ```

   If authentication fails, log in with one of these methods:

   - **Interactive login (TTY):**
     ```bash
     facet login
     ```

   - **CI/automation (set environment variable):**
     Set `FACET_TOKEN=fct_pub_…` with your registry publish token before running `facet publish`.

2. **Confirm publishing (permanent action)**

   Published versions are immutable. Confirm with the user that they intend to publish this version. If changes are needed after publishing, you must bump the version, rebuild, and republish.

3. **Build a fresh artifact**

   Always build immediately before publishing to ensure `dist/` matches your current `facet.json`:

   ```bash
   facet build --json
   ```

4. **Publish to the registry**

   ```bash
   facet publish
   ```

5. **Handle version conflicts**

   If publish fails with a "version exists" error, the version is already in the registry. Bump your version and rebuild:

   ```bash
   facet modify facet --version <semver> --json
   facet build --json
   facet publish
   ```

   Replace `<semver>` with your new version (e.g., `1.0.1`).
