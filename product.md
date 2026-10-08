# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Knowledge workers who use an assistant to turn meeting notes into decisions and assigned actions. They need to discover a useful facet, complete setup, and review its output in a visual walkthrough.

## Product Purpose

Provide an installable Meeting to Action example that demonstrates a portable facet with an embedded interface. Success is a reviewed, editable action plan that the user can export as Markdown.

## Operating Context

The primary interface runs inside an assistant with compatible MCP Apps support. Claude Desktop and Codex are intended host surfaces. Rendering and host interactions require verification in each host; packaging alone does not establish compatibility.

A browser harness exercises the same interface with editable sample data and shows when host reasoning is unavailable. Browser results and desktop results are recorded separately.

## Capabilities and Constraints

- A facet packages a skill, web UI assets, and a Bun MCP server as installable files.
- CopilotKit manages React interface state through AG-UI. The host assistant supplies reasoning and exchanges plan inputs and results through MCP tools.
- Setup detects the Facet CLI, offers installation when absent, and delegates OAuth device login to `facet login`. Authentication remains owned by the CLI.
- The embedded workflow requires no independent model API credential.
- The walkthrough supports meeting notes, decisions, editable actions, owners, dates, and Markdown export.
- General runtime provisioning and registry redesign are outside this prototype's scope.

## Brand Commitments

Preserve Studio's existing brand and functionality. Use direct, plain language that describes the task, current state, and available actions.

## Product Principles

- Keep the skill, interface, and server together when installing a facet.
- Make setup progress and recoverable failures visible.
- Keep host-generated proposals editable before export.
- Identify sample data and report support only for host behavior that has been verified.

## Accessibility & Inclusion

Support keyboard operation and accessible controls throughout the staged walkthrough. Provide clear busy, error, and empty states.
