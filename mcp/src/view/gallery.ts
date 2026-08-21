// The Registry screen: what is published, and what it would cost to install it.
//
// One card per facet, in the registry's own idiom — mono name, tinted asset
// chips, an outline Install button. The name opens the Detail screen, which is
// where a facet's versions, README and full asset list live; this screen stays a
// list you can scan.

import {
    asRecord,
    assetChip,
    button,
    element,
    firstString,
    requireDocument,
    type PanelDocument,
    type PanelElement,
    type PanelFragment,
} from "./dom.js";

/** One asset-count chip on a card. */
export interface GalleryCount {
    type: string;
    label: string;
}

/** One facet in the gallery. */
export interface GalleryFacet {
    name: string;
    version: string;
    description: string;
    publisher: string;
    published: string;
    counts: GalleryCount[];
}

/** A browse result, once it has been checked. */
export interface GalleryData {
    query: string;
    /** True when the query matched nothing and the list is everything published. */
    fallback?: boolean;
    results: GalleryFacet[];
}

/** Where an install has got to. */
export type InstallState = "idle" | "installing" | "installed" | "failed";

/** Cards per page. The rest of a result set sits behind the pager. */
export const PAGE_SIZE = 8;

/**
 * How many results the panel asks the server for in one browse. Matches the
 * server's own cap (MAX_LIMIT in browse.ts) — the two are spelled separately
 * because this file is bundled for the browser and must not pull in the
 * server's node-side imports.
 */
export const BROWSE_LIMIT = 24;

/** Everything the gallery draws that isn't the search result itself. */
export interface GalleryState {
    /** `all`, or one asset type. */
    filter: string;
    /** Which page of the filtered results is showing, from 0. */
    page: number;
    /** What is typed in the search box, not yet searched. */
    draft: string;
    installs: Record<string, InstallState>;
    /** Why an install failed, keyed by facet name. */
    errors: Record<string, string>;
}

export function emptyGalleryState(): GalleryState {
    return { filter: "all", page: 0, draft: "", installs: {}, errors: {} };
}

/** What the gallery asks the console to do. */
export interface GalleryActions {
    install(facet: GalleryFacet): void;
    open(facet: GalleryFacet): void;
    filter(type: string): void;
    /** Keeps the search box's text as it is typed, without a redraw. */
    draft(value: string): void;
    /** Runs the search the draft describes. */
    search(): void;
    /** Moves to a page of the current results. */
    page(next: number): void;
}

function toGalleryCount(value: unknown): GalleryCount | undefined {
    const record = asRecord(value);
    const label = firstString(record.label);
    const type = firstString(record.type);
    return label === undefined ? undefined : { type: type ?? "unknown", label };
}

export function toGalleryFacet(value: unknown): GalleryFacet | undefined {
    const record = asRecord(value);
    const name = firstString(record.name);
    if (name === undefined) {
        return undefined;
    }
    const counts = Array.isArray(record.counts)
        ? record.counts.map(toGalleryCount).filter((count): count is GalleryCount => count !== undefined)
        : [];
    return {
        name,
        version: firstString(record.version) ?? "",
        description: firstString(record.description) ?? "",
        publisher: firstString(record.publisher) ?? "",
        published: firstString(record.published) ?? "",
        counts,
    };
}

/**
 * Reads a browse result, or returns undefined when this isn't one.
 *
 * The discriminator is `kind: "gallery"` on the structured content. Anything
 * else belongs to another screen.
 */
export function toGalleryData(value: unknown): GalleryData | undefined {
    const outer = asRecord(value);
    const structured = asRecord(outer.structuredContent);
    const source = firstString(structured.kind) === "gallery"
        ? structured
        : firstString(outer.kind) === "gallery"
          ? outer
          : undefined;
    if (source === undefined) {
        return undefined;
    }
    const results = Array.isArray(source.results)
        ? source.results.map(toGalleryFacet).filter((facet): facet is GalleryFacet => facet !== undefined)
        : [];
    return {
        query: firstString(source.query) ?? "",
        ...(source.fallback === true ? { fallback: true } : {}),
        results,
    };
}

/** The filters offered above the list, in the registry's order. */
const FILTERS: readonly { key: string; label: string }[] = [
    { key: "all", label: "Everything" },
    { key: "skill", label: "Skills" },
    { key: "agent", label: "Agents" },
    { key: "command", label: "Commands" },
    { key: "server", label: "MCP" },
];

/** Whether a facet carries at least one asset of the filtered type. */
function matchesFilter(facet: GalleryFacet, filter: string): boolean {
    return filter === "all" || facet.counts.some(count => count.type === filter);
}

const INSTALL_LABELS: Record<InstallState, string> = {
    idle: "Install",
    installing: "Installing…",
    installed: "Installed",
    failed: "Retry",
};

const INSTALL_CLASSES: Record<InstallState, string> = {
    idle: "cta cta-lead",
    installing: "cta cta-busy",
    installed: "cta cta-done",
    failed: "cta cta-failed",
};

/** The search box and its button, above the filters. */
function searchBar(doc: PanelDocument, state: GalleryState, actions: GalleryActions): PanelElement {
    const bar = element(doc, "div", "searchbar");

    const input = element(doc, "input", "field-input search-input");
    input.setAttribute("id", "registry-search");
    input.setAttribute("type", "search");
    input.setAttribute("placeholder", "Search the registry…");
    input.setAttribute("aria-label", "Search the registry");
    input.value = state.draft;
    input.addEventListener?.("input", () => actions.draft(input.value ?? ""));
    input.addEventListener?.("keydown", event => {
        if (event?.key === "Enter") {
            actions.search();
        }
    });
    bar.appendChild(input);
    bar.appendChild(button(doc, "cta cta-lead search-go", "Search", () => actions.search()));
    return bar;
}

/** Prev / Next and where you are, under the list. Only drawn when there is more than a page. */
function pager(doc: PanelDocument, page: number, pageCount: number, total: number, actions: GalleryActions): PanelElement {
    const row = element(doc, "div", "pager");

    const prev = button(doc, "filter pager-btn", "‹ Prev", () => actions.page(page - 1));
    if (page === 0) {
        prev.setAttribute("disabled", "disabled");
    }
    row.appendChild(prev);

    const first = page * PAGE_SIZE + 1;
    const last = Math.min(total, (page + 1) * PAGE_SIZE);
    row.appendChild(element(doc, "p", "pager-label", `${first}–${last} of ${total}`));

    const next = button(doc, "filter pager-btn", "Next ›", () => actions.page(page + 1));
    if (page >= pageCount - 1) {
        next.setAttribute("disabled", "disabled");
    }
    row.appendChild(next);
    return row;
}

/** Draws the browse gallery: one card per facet. */
export function renderGallery(
    data: GalleryData,
    state: GalleryState,
    actions: GalleryActions,
    doc: PanelDocument = requireDocument(),
): PanelFragment {
    const fragment = doc.createDocumentFragment();
    const shown = data.results.filter(facet => matchesFilter(facet, state.filter));

    // The page is clamped here rather than trusted, because a filter or a fresh
    // search can shrink the result set under a page number that used to fit.
    const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    const page = Math.min(Math.max(state.page, 0), pageCount - 1);

    const head = element(doc, "header", "gallery-head");
    head.appendChild(element(doc, "p", "operation", data.query === "" ? "Registry" : `Search · ${data.query}`));
    head.appendChild(
        element(doc, "p", "gallery-count", `${shown.length} ${shown.length === 1 ? "facet" : "facets"}`),
    );
    fragment.appendChild(head);

    fragment.appendChild(searchBar(doc, state, actions));

    if (data.fallback === true && data.query !== "") {
        fragment.appendChild(
            element(doc, "p", "fallback-note", `Nothing matched “${data.query}” — showing everything published.`),
        );
    }

    const filters = element(doc, "div", "filters");
    for (const entry of FILTERS) {
        const on = state.filter === entry.key;
        const node = button(doc, on ? "filter filter-on" : "filter", entry.label, () => actions.filter(entry.key));
        node.setAttribute("aria-pressed", on ? "true" : "false");
        filters.appendChild(node);
    }
    fragment.appendChild(filters);

    if (shown.length === 0) {
        const empty = element(doc, "div", "empty-state");
        empty.appendChild(
            element(
                doc,
                "p",
                "empty",
                data.results.length === 0
                    ? data.query === ""
                        ? "The registry returned no facets."
                        : `Nothing matched ${data.query}.`
                    : "No facet in these results carries that.",
            ),
        );
        if (data.results.length > 0) {
            empty.appendChild(button(doc, "cta cta-lead", "Show everything", () => actions.filter("all")));
        }
        fragment.appendChild(empty);
        return fragment;
    }

    const list = element(doc, "div", "gallery");
    for (const facet of shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        list.appendChild(galleryCard(doc, facet, state, actions));
    }
    fragment.appendChild(list);

    if (pageCount > 1) {
        fragment.appendChild(pager(doc, page, pageCount, shown.length, actions));
    }
    return fragment;
}

function galleryCard(
    doc: PanelDocument,
    facet: GalleryFacet,
    state: GalleryState,
    actions: GalleryActions,
): PanelElement {
    const card = element(doc, "article", "card facet-card");

    const top = element(doc, "div", "facet-top");
    const heading = element(doc, "div", "facet-heading");
    const name = button(doc, "facet-name", facet.name, () => actions.open(facet));
    heading.appendChild(name);
    if (facet.version !== "") {
        heading.appendChild(element(doc, "span", "facet-version", facet.version));
    }
    top.appendChild(heading);

    const status = state.installs[facet.name] ?? "idle";
    const install = button(doc, INSTALL_CLASSES[status], INSTALL_LABELS[status], () => actions.install(facet));
    if (status === "installing" || status === "installed") {
        install.setAttribute("disabled", "true");
    }
    top.appendChild(install);
    card.appendChild(top);

    if (facet.publisher !== "") {
        card.appendChild(element(doc, "p", "facet-by", `by ${facet.publisher}`));
    }
    if (facet.description !== "") {
        card.appendChild(element(doc, "p", "facet-desc", facet.description));
    }

    const failure = state.errors[facet.name];
    if (status === "failed" && failure !== undefined) {
        card.appendChild(element(doc, "p", "facet-error", failure));
    }

    const foot = element(doc, "div", "facet-foot");
    const chips = element(doc, "div", "facet-chips");
    for (const entry of facet.counts) {
        chips.appendChild(assetChip(doc, entry.type, entry.label));
    }
    foot.appendChild(chips);

    const meta = element(doc, "div", "facet-meta");
    if (facet.published !== "") {
        meta.appendChild(element(doc, "span", "facet-date", facet.published));
    }
    meta.appendChild(button(doc, "facet-toggle", "What is inside", () => actions.open(facet)));
    foot.appendChild(meta);
    card.appendChild(foot);

    return card;
}
