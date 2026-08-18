#!/usr/bin/env bash
set -euo pipefail

# Initialize temp directory variable (must be before trap to avoid set -u error)
tmp=""

# Cleanup on exit - only remove if tmp was created (handles early exit from adapter check)
trap 'if [[ -n "$tmp" && -d "$tmp" ]]; then rm -rf "$tmp"; fi' EXIT

# Precheck: verify both adapters are installed
if ! facet adapter list | grep -q "claude-code"; then
  echo "error: claude-code adapter not installed" >&2
  exit 2
fi

if ! facet adapter list | grep -q "codex"; then
  echo "error: codex adapter not installed" >&2
  exit 2
fi

# Derive repo path from script location (one level up from scripts/)
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Create scratch project structure
tmp="$(mktemp -d)"
mkdir -p "$tmp/proj/vendor"

# Rsync repo to vendor directory, excluding common build/git artifacts
rsync -a --exclude .git --exclude .brigade --exclude plugin --exclude node_modules --exclude dist \
  "$repo_root/" "$tmp/proj/vendor/facet-studio/"

# Install facet in the temp project
cd "$tmp/proj"
facet add ./vendor/facet-studio </dev/null

# Define expected files (24 total)
declare -a required_paths=(
  # claude-code adapter (12 files)
  ".claude/skills/using-facets/SKILL.md"
  ".claude/skills/authoring/SKILL.md"
  ".claude/skills/presentation/SKILL.md"
  ".claude/commands/facet-add.md"
  ".claude/commands/facet-build.md"
  ".claude/commands/facet-create.md"
  ".claude/commands/facet-list.md"
  ".claude/commands/facet-modify.md"
  ".claude/commands/facet-publish.md"
  ".claude/commands/facet-remove.md"
  ".claude/commands/facet-update.md"
  ".claude/agents/facet-author.md"
  # codex adapter (12 files) - adapter materialization only; Codex does not scan .agents/commands/
  ".agents/skills/using-facets/SKILL.md"
  ".agents/skills/authoring/SKILL.md"
  ".agents/skills/presentation/SKILL.md"
  ".agents/commands/facet-add.md"
  ".agents/commands/facet-build.md"
  ".agents/commands/facet-create.md"
  ".agents/commands/facet-list.md"
  ".agents/commands/facet-modify.md"
  ".agents/commands/facet-publish.md"
  ".agents/commands/facet-remove.md"
  ".agents/commands/facet-update.md"
  ".codex/agents/facet-author.toml"
)

# Check all paths exist
for path in "${required_paths[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "error: missing $path" >&2
    exit 1
  fi
done

# Check that .claude and .agents SKILL.md files have required frontmatter keys
for skill_path in .claude/skills/*/SKILL.md .agents/skills/*/SKILL.md; do
  if ! head -1 "$skill_path" | grep -q "^---$"; then
    echo "error: $skill_path missing frontmatter (should start with ---)" >&2
    exit 1
  fi
  # Extract frontmatter block (lines between opening and closing ---)
  frontmatter=$(awk 'NR==1 && /^---$/ {in_fm=1; next} in_fm && /^---$/ {exit} in_fm' "$skill_path")
  if ! echo "$frontmatter" | grep -q "^name:"; then
    echo "error: $skill_path missing 'name:' in frontmatter" >&2
    exit 1
  fi
  if ! echo "$frontmatter" | grep -q "^description:"; then
    echo "error: $skill_path missing 'description:' in frontmatter" >&2
    exit 1
  fi
done

# Check that .codex/agents/facet-author.toml has all required fields
if ! grep -q "^name = " .codex/agents/facet-author.toml; then
  echo "error: .codex/agents/facet-author.toml missing 'name = ' field" >&2
  exit 1
fi
if ! grep -q "^description = " .codex/agents/facet-author.toml; then
  echo "error: .codex/agents/facet-author.toml missing 'description = ' field" >&2
  exit 1
fi
if ! grep -q "^developer_instructions = " .codex/agents/facet-author.toml; then
  echo "error: .codex/agents/facet-author.toml missing 'developer_instructions = ' field" >&2
  exit 1
fi

echo "NOTE: .agents/commands/ checks verify adapter materialization only; Codex does not scan .agents/commands/ (upstream adapter issue)"

# Verify plugin MCP server exists and boots
if [[ ! -f "$repo_root/plugin/mcp/server.mjs" ]]; then
  echo "error: plugin MCP server not found at plugin/mcp/server.mjs" >&2
  exit 1
fi

# Boot the server in background with stdin piped from sleep to keep it alive, verify it stays running
cd "$repo_root"
(sleep 10) | node plugin/mcp/server.mjs >/dev/null 2>&1 &
server_pid=$!
sleep 3
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "error: plugin MCP server failed to boot or exited prematurely (PID $server_pid)" >&2
  exit 1
fi
kill "$server_pid" 2>/dev/null || true

echo "NOTE: plugin MCP server verified to boot and stay alive"
echo "verify-install: OK"
