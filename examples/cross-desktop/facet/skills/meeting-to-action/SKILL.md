# Meeting to Action

Use this skill when the user wants to turn meeting notes into reviewed decisions and actions.

Open the worksheet with the `meeting_open` MCP tool. If the tool is unavailable, follow [host setup](references/host-setup.md) to connect the bundled server.

The host assistant supplies reasoning. Read the user's notes, preserve uncertainty, and call `meeting_plan` with a complete plan. Include the original notes, decisions, and actions with stable IDs, task text, owner, due date, and completion state. Set `source` to `host`. Use only owners and dates supported by the notes; leave unknown values empty. Ask about meaningful ambiguity in the conversation.

The worksheet receives the tool result and lets the user edit decisions, owners, dates, and actions. Let the user review before exporting Markdown. Do not send messages or create external tasks from this skill.

The browser preview uses the same worksheet with a clearly identified sample. It does not supply assistant reasoning. No separate model credential is required.
