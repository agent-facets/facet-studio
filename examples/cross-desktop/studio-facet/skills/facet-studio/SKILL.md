# Find a workflow for the user’s task

## Choose the connected workflow first

For requests to find or recommend a facet, or install and open an interactive knowledge-work app, check connected tools for studio_search, including a host-prefixed name. If availability is uncertain, use the host's tool-discovery mechanism before choosing a CLI fallback. Call the connected search first with the user's task and constraints. Do not start with shell discovery, CLI authentication probes, or public web searches.

Use the returned inline Studio app for selection and explicit installation approval, then its Open action for the installed facet's own UI. Do not replace this workflow with CLI instructions or a website recommendation when Studio is available. CLI authoring, publishing, dependency maintenance and explicit CLI requests remain CLI workflows.

A CLI sandbox or credential-access failure does not establish whether the connected Studio service is authenticated or a private facet is available. Try connected discovery first. If Studio reports authentication or access failure, report that result and use its available studio_setup flow. Never substitute public web search for private package discovery or an authentication failure; do not request or expose tokens.

## Carry the task into discovery

When the user asks for help with knowledge work, proactively find a relevant interactive facet. They do not need to mention Studio, tools, or a search screen. For “Can you help me organize my meeting notes?”, call studio_search with query “meeting notes actions” and show its inline result.

Derive two to five concise task keywords from the request. Prefer task nouns and useful synonyms: meeting notes, minutes, decisions, owners, action items, follow-ups. Avoid generic words such as help, organize, or please. Pass the keywords in the initial query argument so the card opens with meaningful search context already filled in. Use an empty query only when the user wants to browse supported registry entries.

This prototype searches the real @agentfacets registry using the existing Facet CLI login. It currently shows only the supported Meeting to Action app. Published versions come from authenticated registry search; no Meeting UI or server is bundled in Studio. If there is no suitable result, say so and continue helping normally. Do not claim every host will automatically discover or render the workflow.

Search does not authorize installation. Let the user choose the facet and explicitly approve installation in the inline review component. Installation uses the exact published version the user reviewed. Then use the returned app.openTool to open the installed worksheet. Stable bridge tools are deliberately advertised before installation for hosts with cached tool lists; their presence is not proof that an app is installed. Trust the result’s installed field.

Use studio_setup only to inspect or explicitly configure the Facet CLI; the CLI owns authentication. The host may place a worksheet request in its composer for the user to send.

The declared companions contain only the Studio MCP server and discovery UI. Meeting to Action arrives separately through registry installation; its installed descriptor and executable/UI companion hashes must match the CLI registry receipt before opening. Configure Bun with the absolute installed assets/studio-server.js path once as a stdio MCP server. MCP Apps rendering is required; no separate server or post-install restart is needed for each facet.
