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

# Define expected files (22 total)
declare -a required_paths=(
  # claude-code adapter (11 files)
  ".claude/skills/using-facets/SKILL.md"
  ".claude/skills/authoring/SKILL.md"
  ".claude/commands/facet-add.md"
  ".claude/commands/facet-build.md"
  ".claude/commands/facet-create.md"
  ".claude/commands/facet-list.md"
  ".claude/commands/facet-modify.md"
  ".claude/commands/facet-publish.md"
  ".claude/commands/facet-remove.md"
  ".claude/commands/facet-update.md"
  ".claude/agents/facet-author.md"
  # codex adapter (11 files)
  ".agents/skills/using-facets/SKILL.md"
  ".agents/skills/authoring/SKILL.md"
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

# Check that .claude and .agents SKILL.md files start with frontmatter
for skill_path in .claude/skills/*/SKILL.md .agents/skills/*/SKILL.md; do
  if ! head -1 "$skill_path" | grep -q "^---$"; then
    echo "error: $skill_path missing frontmatter (should start with ---)" >&2
    exit 1
  fi
done

# Check that .codex/agents/facet-author.toml contains 'description'
if ! grep -q "description" .codex/agents/facet-author.toml; then
  echo "error: .codex/agents/facet-author.toml missing 'description' field" >&2
  exit 1
fi

echo "verify-install: OK"
