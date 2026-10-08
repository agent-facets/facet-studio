# Intent

Knowledge workers discover and install a facet, then follow its packaged visual walkthrough inside a compatible assistant. The Meeting to Action example turns meeting notes into an editable action plan with decisions, owners, and dates.

A facet packages a skill, its web UI, and a Bun MCP server. These files travel together. Rendering and assistant interactions depend on the host's MCP Apps support and must be verified for each host. Claude Desktop and Codex are intended desktop surfaces; a browser harness exercises the same UI with clearly identified sample data.

CopilotKit manages interactive React state through AG-UI. The host assistant supplies reasoning and sends results through MCP tools. This workflow requires no independent model API credential.

Setup detects the Facet CLI, offers installation when it is missing, and delegates OAuth device login to `facet login`. The walkthrough makes setup progress, failures, and the next available action visible.

Success means a user can install the example, open its walkthrough, supply meeting notes, review the host's proposed plan, edit it, and export Markdown. Preserve Studio's existing functionality and brand. Record actual browser and desktop verification separately.
