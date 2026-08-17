# facet-create

Scaffold a new facet skill, agent, or command with validation and asset initialization.

## Task

Create a new facet in the current workspace by providing a name, description, and at least one asset type (skill, agent, or command). The workflow validates input, scaffolds the facet structure, and outputs the created tree as JSON.

## Steps

1. **Gather input:** prompt for facet name, description, version (optional), privacy flag, and asset selections (at least one skill, agent, or command name required).

2. **Validate names:** before using any value in a shell command, validate:
   - Facet name: must match `^[a-z]([a-z0-9]*(-[a-z0-9]+)*)?(@[a-z]([a-z0-9]*(-[a-z0-9]+)*)?)?$` and be ≤ 64 chars total (each `@scope/` part ≤ 64 chars)
   - Each skill/agent/command name: must match `^[a-z]([a-z0-9]*(-[a-z0-9]+)*)?$` and be ≤ 64 chars
   - If any name fails validation, report the grammar rule and stop — do not proceed.

3. **Require at least one asset:** if no skills, agents, or commands are specified, tell the user "no assets to scaffold" and stop.

4. **Run create:** construct and execute:
   ```
   facet create <target-dir> --name '<validated-name>' \
     --description '<validated-description>' \
     [--version <version>] [--private] \
     [--skill '<name>']... [--agent '<name>']... [--command '<name>']... \
     --no-readme --json
   ```

5. **Report result:** output the JSON response showing the created facet structure and asset list. If the facet already exists, `facet create` exits 1; offer `--force` only with explicit user consent (see manifest-assets for asset publishing workflow).

6. **Next steps:** direct the user to facet-modify for asset customization and facet.json editing for build settings.
