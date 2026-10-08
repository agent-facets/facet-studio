# Meeting worksheet design

This surface extends Studio's existing visual system. Its purpose is Operate: install a facet, capture meeting notes, and review an editable plan.

The staged navigation remains visible beside the worksheet on wide screens. It stacks above the worksheet below 800px. The three steps represent setup, source capture, and review. The persistent connection message distinguishes an MCP Apps host from the browser preview.

Dark colors inherit `mcp/src/view/tokens.ts`: page #0a0a12, elevated surface #12121c, foreground #f5f4ff, muted text #a8a6c4, and skill accent #a78bfa. The light theme uses the same source's warm page, white surface, deep purple accent and darker text. Host theme changes update the document. A manual theme control supports the browser preview.

Typography follows Studio's Geist/Inter/system stack. Native form controls use the same font. The worksheet uses one elevated region, clear field labels, generous separation between tasks, visible focus outlines, and responsive owner/date fields. Action removal is explicitly labelled, and status updates use a polite live region.

The interaction that defines the surface is the transition from host-supplied notes to editable actions in the same worksheet. Source notes remain available while decisions and assignments can be changed. Empty, busy, error and host-unavailable states explain the next action.

Desktop and mobile captures are under `.impeccable/review/`. Independent finish review is tracked by the parent Brigade dish; this record does not assert that review passed.
