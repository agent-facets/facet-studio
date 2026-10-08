# Find a workflow for the user’s task

When the user asks for help with knowledge work, proactively find a relevant interactive facet. They do not need to mention Studio, tools, or a search screen. For “Can you help me organize my meeting notes?”, call studio_search with query “meeting notes actions” and show its inline result.

Derive two to five concise task keywords from the request. Prefer task nouns and useful synonyms: meeting notes, minutes, decisions, owners, action items, follow-ups. Avoid generic words such as help, organize, or please. Pass the keywords in the initial query argument so the card opens with meaningful search context already filled in. Use an empty query only when the user wants to browse all entries.

This prototype searches the explicitly configured local catalogue, not the public registry. If there is no suitable result, say so and continue helping normally. Do not claim every host will automatically discover or render the workflow.

Search does not authorize installation. Let the user choose the facet and explicitly approve installation in the inline review component. Then use the returned app.openTool to open the installed worksheet. Stable bridge tools are deliberately advertised before installation for hosts with cached tool lists; their presence is not proof that an app is installed. Trust the result’s installed field.

Use studio_setup only to inspect or explicitly configure the Facet CLI; the CLI owns authentication. The host may place a worksheet request in its composer for the user to send.

The declared companion assets contain the Studio MCP server, discovery UI, catalogue and bundled meeting example. Configure Bun with the absolute installed assets/studio-server.js path once as a stdio MCP server. MCP Apps rendering is required; no separate server or post-install restart is needed for each facet.
