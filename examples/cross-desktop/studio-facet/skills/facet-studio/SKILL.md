# Facet Studio local catalogue

Use studio_search to discover facets in the configured local prototype catalogue. Results explicitly identify the local source; this prototype does not search the public registry.

Use studio_setup to inspect or explicitly configure the Facet CLI. Authentication remains owned by the CLI. Install a selected catalogue entry with studio_install, then call the returned app.openTool to open the installed app in the current MCP connection. The host may place a worksheet's request in the composer; let the user send it.

The companion assets contain the Studio MCP server, discovery interface, catalogue configuration, and packaged local example. Configure `bun <absolute-installed-skill-path>/assets/studio-server.js` once as a stdio MCP server. Bun is required. Do not configure a separate server for each catalogue facet. Host support for dynamic tool lists and MCP Apps is required.
