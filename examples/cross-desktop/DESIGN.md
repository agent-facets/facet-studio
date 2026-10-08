# Meeting worksheet design

This surface extends Studio's existing visual system. Its purpose is Operate: install a facet, capture meeting notes, and review an editable plan.

The staged navigation remains visible beside the worksheet on wide screens. It stacks above the worksheet below 800px. The three steps represent setup, source capture, and review. The persistent connection message distinguishes an MCP Apps host from the browser preview.

Dark colors inherit `mcp/src/view/tokens.ts`: page #0a0a12, elevated surface #12121c, foreground #f5f4ff, muted text #a8a6c4, and skill accent #a78bfa. The light theme uses the same source's warm page, white surface, deep purple accent and darker text. Host theme changes update the document. A manual theme control supports the browser preview.

Typography follows Studio's Geist/Inter/system stack. Native form controls use the same font. The worksheet uses one elevated region, clear field labels, generous separation between tasks, visible focus outlines, and responsive owner/date fields. Action removal is explicitly labelled, and status updates use a polite live region.

The interaction that defines the surface is the transition from host-supplied notes to editable actions in the same worksheet. Source notes remain available while decisions and assignments can be changed. Empty, busy, error and host-unavailable states explain the next action.

Desktop and mobile captures are under `.impeccable/review/`. Independent finish review is tracked by the parent Brigade dish; this record does not assert that review passed.

## Inline facet discovery

Discovery is a compact Operate surface inside the assistant conversation. A knowledge worker moves from a task search to a real local facet, installs it, and asks the host to open its installed app in a new inline card. The catalogue is explicitly local; search results come from the server. The composer handoff remains visible because a host may require the user to send the prepared request.

The single column is capped at 520px with no viewport-height minimum or sidebar. Studio's wordmark, restrained purple accent, Geist/Inter/system typography and paired warm-light/deep-dark tokens carry the identity. The host's initial theme and later changes select the palette; discovery adds no independent theme toggle. One divided result region keeps name, description, local source and version together, with Install facet changing to Open in chat after a verified install. No illustrative images or extra visual world are needed for this small operational surface.

Search has a visible label and submit button. Empty results name the submitted query, status is announced politely, errors offer retry, and controls retain visible keyboard focus. CLI setup sits in a disclosure rather than a required onboarding stage. Its device URL/code are validated and its install/login/cancel actions are explicit. Native rendering and the complete installed-app handoff require integrated host verification; this design record alone is not evidence of either.
