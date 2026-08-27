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
// that's just as much a recitation risk as the text was, and asking it not to
// recite what is sitting in front of it turned out to lose to any skill that
// told it to write something. So on those hosts the full payload moves to
// `_meta`, where the panel reads it straight off the tool result, and
// structuredContent shrinks to a summary: names, counts, and the handful of
// facts a follow-up call needs, with nothing in it that reads as prose.
// Text-only hosts are untouched — they get the full payload in
// structuredContent, same as before this existed.

import { PANEL_PAYLOAD_KEY } from "./view/dom.js";

/** The sentence that tells a host's model the panel already answered. */
export function panelShows(brief: string): string {
    return (
        `${brief}\n` +
        "The Facet Studio panel is showing this result, and the panel IS the answer. The user is already " +
        "looking at every name, description, and count, and can search, page, open details, and install " +
        "right there. Write nothing after this. Do not restate any of it — no prose summary, no bullets, " +
        "no table, no \"here are the ones that fit\", no recommendations, no \"want me to install one?\". " +
        "A question about which results fit is answered by the panel too: the user reads the rows and " +
        "clicks. Do not call more facet tools to add context they did not ask for (every extra call stacks " +
        "another widget), and do not suggest CLI commands for things the panel can do. Speak only if the " +
        "user asked for something the panel genuinely cannot show, and then in one short sentence."
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
 * the panel's own readers pick it up. The instruction in `panelShows` says not
 * to recite; the starved summary is what makes that easy to obey, because
 * there is nothing there to write out. `summary.kind` has to be the "-summary"
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
