---
name: authoring
description: "Guidelines for authoring quality facet assets - skills, agents, and commands: naming rules, manifest metadata, adapter config, and content conventions. Load when writing or reviewing facet asset content."
---

# Authoring

A facet is a reusable bundle of knowledge, persona, and workflows. Each asset—skill, agent, command—serves one purpose, follows naming conventions, and declares metadata in facet.json only.

## Asset Types

| Asset | When to use | Example trigger |
|-------|-----------|-----------------|
| **Skill** | Passive knowledge an assistant applies to its reasoning. Model reads it when solving a task that matches the trigger description. | "when the user asks about CLI syntax" |
| **Agent** | Persona with a specific role and tool posture. Activates as a subprocess, constrained to its declared behavior. | Multi-step workflow tool; conversational assistant in a narrow domain |
| **Command** | User-invoked workflow. CLIs, shortcuts, automation pipelines that run when named. | "when the user runs a specific workflow" |

## Naming Rules

Names are 1–64 lowercase ASCII letters, digits, and hyphens. No leading/trailing/consecutive hyphens; no forward slashes. Skills and commands share one namespace (a skill and command cannot both be named `cache-buster`). Agents have their own namespace.

```bash
# Valid
my-skill, skill-v2, auth-token-cache
# Invalid
MySkill, my--skill, -skill, skill-, skill/cache
```

## Metadata & Frontmatter

Metadata—descriptions, adapter config, companion file lists—lives **only** in facet.json. Asset files carry no YAML frontmatter. Set metadata with:

```bash
facet modify ASSET --description "..."
facet modify AGENT --adapter-<name> '<json>'
```

The model's trigger text comes directly from facet.json's description. Lead with *when* to load it:

**Good:** "when debugging server errors or optimizing performance queries"  
**Bad:** "Contains performance tips"

## Authoring Loop

1. Create or stage: `facet modify skill my-skill --add`
2. Write the body in the asset file (no frontmatter)
3. Verify locally: `facet build --verify`
4. Build and install: `facet build`

Skills may declare companion files via the manifest `files` list. The primary asset file is the entrypoint; refer to `facet instructions authoring` and `facet instructions manifest` for complete reference.

## MCP Server Routing

When the facet-studio MCP server is connected, prefer its `facet_*` tools over raw CLI calls — same operations, structured results, branded panels where the host renders them; load the `presentation` skill for output formatting. The CLI path below remains the fallback.