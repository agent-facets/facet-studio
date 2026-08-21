// What a tool's text says, given who is going to read it.
//
// Every tool answers twice: structuredContent for the panel and for machines,
// text for whoever reads the transcript. On a text-only host the text is the
// entire surface, so it carries everything. On a host that renders the console,
// the user is already looking at the answer — a model that then recites the
// same list in prose shows everything twice, and the duplicate is the longer
// and worse-looking of the two. So when the panel will render, the text shrinks
// to one line and says why, and the full story stays with the hosts that need
// it.

/** The sentence that tells a host's model the panel already answered. */
export function panelShows(brief: string): string {
    return (
        `${brief}\n` +
        "The Facet Studio panel is showing this result — the user can search, open details, and install " +
        "right in it. Do not restate its contents in prose (no tables, no lists of the results), do not " +
        "call more facet tools to add context they did not ask for (every extra call stacks another widget), " +
        "and do not suggest CLI commands for things the panel can do. If the request needs judgment the " +
        "panel lacks — say, which results actually fit — give it in one or two plain sentences naming only " +
        "those items. Otherwise reply in one sentence or ask what they want to do next."
    );
}

/**
 * Picks a read's text: the whole story for a text-only host, a pointer at the
 * panel for one that renders it.
 *
 * The full text is a thunk because on an apps host it is never built — some of
 * the full renderings walk every row of a result.
 */
export function readout(supportsUi: boolean | undefined, brief: string, full: () => string): string {
    return supportsUi === true ? panelShows(brief) : full();
}
