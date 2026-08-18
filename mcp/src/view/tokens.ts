// Design tokens for the panel, mirrored from the registry UI.
//
// The registry (facet-registry/packages/ui/src/styles/colors_and_type.css) is what
// people actually see at agentfacets.io, so the panel follows it rather than the
// brand package. The two disagree in ways that matter here:
//
//   - The brand's `inkFaint` (#6a6890) is 3.75:1 on the page background, which fails
//     AA for body text. The registry uses #8583a8 (5.45:1).
//   - The brand's `ASSET_TYPE_COLORS` map skills to #8b5cf6 and agents to #ec4899.
//     The registry uses #a78bfa and #f472b6; #8b5cf6 as small text is only 4.39:1 on
//     an elevated card.
//   - The brand's light accents fail badly as text (amber 2.67:1, green 1.81:1), so
//     the registry defines its own darker light-theme set instead.
//
// Reconciling the two is tracked upstream as `brand-light-accents-fail-contrast`.
// Until that lands, this file is the panel's source of truth. Every value below is
// copied verbatim from the registry stylesheet.

/** Font stacks, from the registry's generated brand-tokens.css. */
const FONTS = {
    sans: "'Geist Variable', 'Geist', Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    mono: "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
    serif: "'Instrument Serif', ui-serif, Georgia, 'Times New Roman', serif",
} as const;

/**
 * Per-asset-type accent colors, keyed by the singular type name the tools emit.
 *
 * `server` is labelled MCP in the registry UI, but the key stays `server` because
 * that is what `facet.json` and the CLI call it.
 */
export const ASSET_ACCENTS = {
    skill: "var(--accent-skill)",
    agent: "var(--accent-agent)",
    command: "var(--accent-command)",
    server: "var(--accent-mcp)",
} as const;

/** What the registry calls each asset type, singular and plural. */
export const ASSET_LABELS: Record<string, { one: string; many: string }> = {
    skill: { one: "Skill", many: "Skills" },
    agent: { one: "Agent", many: "Agents" },
    command: { one: "Command", many: "Commands" },
    server: { one: "MCP", many: "MCP" },
};

/**
 * The token stylesheet.
 *
 * Dark is the default, matching the registry. The light block keys off
 * `html[data-theme="light"]`, which is what `applyDocumentTheme` sets from the
 * host's theme — so a light host gets a light panel with no extra wiring.
 */
export function buildRegistryTokensCss(): string {
    return `:root {
  --accent-a: #8b5cf6;
  --accent-b: #ec4899;
  --accent-c: #38bdf8;
  --accent-d: #fde047;
  --bg: #0a0a12;
  --bg-elev: #12121c;
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.16);
  --card: rgba(255, 255, 255, 0.035);
  --ink: #f5f4ff;
  --ink-dim: #a8a6c4;
  --ink-faint: #8583a8;
  --code-key: #38bdf8;
  --code-value: #fde047;
  --accent-skill: #a78bfa;
  --accent-agent: #f472b6;
  --accent-command: #38bdf8;
  --accent-mcp: #fde047;
  --ok: #4ade80;
  --err: #f87171;
  --act: var(--accent-a);
  --sans: ${FONTS.sans};
  --mono: ${FONTS.mono};
  --serif: ${FONTS.serif};
  --r-xs: 4px;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 10px;
  --r-xl: 14px;
  --r-pill: 999px;
  --dur-fast: 0.15s;
  --dur-base: 0.22s;
  --ease-out: cubic-bezier(0.2, 0.9, 0.2, 1);
}

html[data-theme="light"] {
  --accent-a: #7c3aed;
  --accent-b: #db2777;
  --accent-c: #0284c7;
  --accent-d: #ca8a04;
  --bg: #f6f4ef;
  --bg-elev: #ffffff;
  --line: rgba(10, 10, 30, 0.09);
  --line-strong: rgba(10, 10, 30, 0.18);
  --card: rgba(10, 10, 30, 0.03);
  --ink: #0e0e1a;
  --ink-dim: #39374d;
  --ink-faint: #4f4d66;
  --code-key: #0c4a6e;
  --code-value: #713f12;
  --accent-skill: #5b21b6;
  --accent-agent: #9f1239;
  --accent-command: #075985;
  --accent-mcp: #713f12;
  --ok: #166534;
  --err: #dc2626;
}
`;
}
