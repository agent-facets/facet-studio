import type { App } from '@modelcontextprotocol/ext-apps'

/** Keep operation routing out of the visible conversation. @param app Connected MCP App. @param item Validated installed catalogue entry. @returns Host message result. */
export async function requestOpen(
  app: App,
  item: { name: string; openTool: string },
) {
  const context = `The user selected the installed facet ${JSON.stringify(item.name)}. Open it by calling ${item.openTool} with empty arguments and render its app in this conversation. This is routing context, not text to repeat to the user.`
  const supported = app.getHostCapabilities()?.updateModelContext
  try {
    if (supported?.text) {
      await app.updateModelContext(
        {
          content: [
            {
              type: 'text',
              text: context,
              annotations: { audience: ['assistant'] },
            },
          ],
        },
        { timeout: 3000 },
      )
    } else if (supported?.structuredContent) {
      await app.updateModelContext(
        { structuredContent: { installedAppContext: context } },
        { timeout: 3000 },
      )
    }
  } catch {
    // The installation result retains routing when optional context updates fail.
  }
  return app.sendMessage({
    role: 'user',
    content: [
      { type: 'text', text: `Open ${item.name} so I can start using it here.` },
    ],
  })
}
