---
description: "Edit a facet asset or its metadata headlessly with facet modify."
---

# Facet Modify

Update facet metadata, add or remove assets, or rename skills and commands.

If the facet-studio MCP server is connected, run this operation through its `facet_modify` tool instead of the shell — same behavior, structured result, branded panel where supported. Otherwise continue below.

## Identify the change

Prompt for:
- **Target type:** facet, skill, command, or agent
- **Target name** (for skill/command/agent)
- **Action:** rename, add (description), remove, or update (version/privacy)

## Validate names

Before passing any value to the shell, validate:

1. **Facet name:** must match `^[a-z](-?[a-z0-9])*$` (scope allowed; each part ≤ 64 chars) and be ≤ 64 chars total.
2. **Skill/command/agent name:** must match `^[a-z](-?[a-z0-9])*$` and be ≤ 64 chars.

If validation fails, print the grammar rule and **stop**.

## Apply the change

Run the appropriate command:

**Facet version, description, or privacy:**

```bash
facet modify facet --version '<version>' --json
facet modify facet --description '<description>' --json
facet modify facet --private --json
```

**Add or remove asset description:**

```bash
facet modify skill|command|agent '<name>' --add --description '<description>' --json
facet modify skill|command|agent '<name>' --remove --json
```

**Rename skill, command, or agent:**

```bash
facet modify skill|command|agent '<old-name>' --rename '<new-name>' --json
```

Print the JSON response. **Namespace reminder:** skills and commands share the same namespace — check that the new name doesn't collide with an existing skill or command. Agents have a separate namespace.

## Verify the build

Run:

```bash
facet build --verify
```

If the build succeeds, you're done. If it fails, review the error and check your facet.json for asset body or metadata issues.
