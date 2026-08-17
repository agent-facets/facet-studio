# Facet Publish

Publish your facet to the registry. Published versions are immutable—once released, they cannot be modified or deleted.

## Authenticate to the registry

Verify your identity:

```bash
facet whoami
```

If authentication fails, choose one method to log in:

- **Interactive (terminal):**
  ```bash
  facet login
  ```

- **CI/automation (environment variable):**
  Set `FACET_TOKEN=fct_pub_…` with your registry publish token before running `facet publish`. This is the only method for non-interactive environments.

## Confirm publishing is permanent

Publishing is permanent. Confirm that you intend to publish this version. Any changes after publishing require a version bump, rebuild, and republish. Never reuse a version that already exists in the registry.

## Build a fresh artifact

Always build immediately before publishing to prevent publish drift (where `dist/` is built from an older `facet.json`):

```bash
facet build --json
```

## Publish to the registry

```bash
facet publish
```

## Handle version-exists errors

If publish fails because the version already exists in the registry, bump the version and republish:

```bash
facet modify facet --version <semver> --json
facet build --json
facet publish
```

Replace `<semver>` with your new version (e.g., `1.0.1`).
