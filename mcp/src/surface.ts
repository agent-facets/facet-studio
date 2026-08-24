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
//
// The same split applies to structuredContent itself. A host with a panel
// doesn't need the model to see full descriptions in its tool result either —
// that's just as much a recitation risk as the text was. So on those hosts the
// full payload moves to `_meta`, where the panel reads it straight off the tool
// result, and structuredContent shrinks to a summary: bounded per-facet rows
// carrying name, version, a clipped description, asset counts, and install state.
// Recitation is held back by the `panelShows` text instruction rather than by
// starving the payload. Text-only hosts are untouched — they get the full payload
// in structuredContent, same as before this existed.

import { PANEL_PAYLOAD_KEY } from "./view/dom.js";

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

/**
 * Builds a tool result whose payload is sized to who's going to read it.
 *
 * On a text-only host `structuredContent` carries the full `payload`, byte-
 * identical to what every browse-family tool returned before this existed. On
 * a host with a panel, `structuredContent` shrinks to `summary` — names and
 * counts, nothing to recite — and the full `payload` moves to `_meta`, where
 * the panel's own readers pick it up. `summary.kind` has to be the "-summary"
 * variant of the real kind: a host that strips `_meta` before handing the
 * result to its model must fail to match any reader and fall through, not
 * render an empty gallery because the summary happened to answer to the real
 * kind with nothing in it.
 */
export function panelEnvelope(
    supportsUi: boolean | undefined,
    args: { text: string; payload: Record<string, unknown>; summary: Record<string, unknown> },
): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; _meta?: Record<string, unknown> } {
    if (supportsUi !== true) {
        return {
            content: [{ type: "text", text: args.text }],
            structuredContent: args.payload,
        };
    }
    return {
        content: [{ type: "text", text: args.text }],
        structuredContent: args.summary,
        _meta: { [PANEL_PAYLOAD_KEY]: { payload: args.payload } },
    };
}
