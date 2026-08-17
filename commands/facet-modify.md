# facet-modify

Update facet metadata, add/remove assets, or rename facets and their skills/commands.

## Task

Modify an existing facet by updating its version or description, adding/removing skills and commands, renaming skills/commands, or renaming the facet itself. All operations validate input and confirm the facet builds successfully.

## Steps

1. **Identify the modification type:** prompt for target (facet, skill, command, or agent) and the action (rename, add/remove description, update version, set privacy).

2. **Validate names:** before using any value in a shell command, validate:
   - Facet name: must match `^[a-z]([a-z0-9]*(-[a-z0-9]+)*)?(@[a-z]([a-z0-9]*(-[a-z0-9]+)*)?)?$` and be ≤ 64 chars total
   - Skill/command/agent name: must match `^[a-z]([a-z0-9]*(-[a-z0-9]+)*)?$` and be ≤ 64 chars
   - If validation fails, report the grammar and stop — do not proceed.

3. **Execute the appropriate modify command:**
   - **Facet metadata:** `facet modify facet --version '<version>' --json` or `facet modify facet --description '<description>' --json` or `facet modify facet --private --json`
   - **Skill or command:** `facet modify skill|command '<name>' --add --description '<description>' --json` or `facet modify skill|command '<name>' --remove --json`
   - **Rename:** `facet modify skill|command '<old-name>' --rename '<new-name>' --json` (note: skills and commands share a namespace; renaming warns the user)

4. **Verify build:** after any modify operation, run:
   ```
   facet build --verify
   ```
   If the build fails, report the error and offer guidance on facet.json.

5. **Rename namespace reminder:** when renaming a skill or command, remind the user that skills and commands exist in the same namespace — the new name must not collide with an existing command or skill.
