// The Detail screen: one facet, at length.
//
// Reached by opening a facet from the Registry screen. Three tabs divide what
// there is to know — what is inside it, what versions it has had, and whatever
// README it ships. The README is fetched only when its tab is opened, because
// the endpoint behind it returns every text file in the facet.

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
import type { GalleryCount } from "./gallery.js";

/** One asset inside the facet. */
export interface DetailAsset {
    type: string;
    name: string;
    detail: string;
}

/** Everything the screen draws about one published version. */
export interface DetailData {
    facet: string;
    version: string;
    description: string;
    publisher: string;
    published: string;
    visibility: string;
    counts: GalleryCount[];
    assets: DetailAsset[];
    /** Every published version, newest first. */
    versions: string[];
}

/** The README of one version, once it has been fetched. */
export interface ReadmeData {
    file: string;
    text: string;
    truncated: boolean;
}

export type DetailTab = "contents" | "versions" | "readme";

/** Everything the screen draws that isn't the facet itself. */
export interface DetailState {
    tab: DetailTab;
    /** READMEs already fetched, keyed by version. */
    readmes: Record<string, ReadmeData>;
    /** True while a README is in flight. */
    loadingReadme: boolean;
    install: "idle" | "installing" | "installed" | "failed";
    error?: string;
}

export function emptyDetailState(): DetailState {
    return { tab: "contents", readmes: {}, loadingReadme: false, install: "idle" };
}

/** What the screen asks the console to do. */
export interface DetailActions {
    tab(tab: DetailTab): void;
    install(): void;
    /** Open another version of the same facet. */
    version(version: string): void;
    back(): void;
}

function toDetailAsset(value: unknown): DetailAsset | undefined {
    const record = asRecord(value);
    const name = firstString(record.name);
    if (name === undefined) {
        return undefined;
    }
    return {
        name,
        type: firstString(record.type) ?? "unknown",
        detail: firstString(record.detail, record.description) ?? "",
    };
}

function toCount(value: unknown): GalleryCount | undefined {
    const record = asRecord(value);
    const label = firstString(record.label);
    return label === undefined ? undefined : { type: firstString(record.type) ?? "unknown", label };
}

/** Reads a detail result, or returns undefined when this isn't one. */
export function toDetailData(value: unknown): DetailData | undefined {
    const outer = asRecord(value);
    const structured = asRecord(outer.structuredContent);
    const source = firstString(structured.kind) === "detail"
        ? structured
        : firstString(outer.kind) === "detail"
          ? outer
          : undefined;
    if (source === undefined) {
        return undefined;
    }
    const facet = firstString(source.facet, source.name);
    if (facet === undefined) {
        return undefined;
    }
    return {
        facet,
        version: firstString(source.version) ?? "",
        description: firstString(source.description) ?? "",
        publisher: firstString(source.publisher) ?? "",
        published: firstString(source.published) ?? "",
        visibility: firstString(source.visibility) ?? "",
        counts: Array.isArray(source.counts)
            ? source.counts.map(toCount).filter((count): count is GalleryCount => count !== undefined)
            : [],
        assets: Array.isArray(source.assets)
            ? source.assets.map(toDetailAsset).filter((asset): asset is DetailAsset => asset !== undefined)
            : [],
        versions: Array.isArray(source.versions)
            ? source.versions.filter((entry): entry is string => typeof entry === "string")
            : [],
    };
}

/** Reads a README result, or returns undefined when this isn't one. */
export function toReadmeData(value: unknown): ReadmeData | undefined {
    const outer = asRecord(value);
    const structured = asRecord(outer.structuredContent);
    const source = firstString(structured.kind) === "readme"
        ? structured
        : firstString(outer.kind) === "readme"
          ? outer
          : undefined;
    if (source === undefined) {
        return undefined;
    }
    return {
        file: firstString(source.file) ?? "",
        text: typeof source.text === "string" ? source.text : "",
        truncated: source.truncated === true,
    };
}

const TABS: readonly { key: DetailTab; label: string }[] = [
    { key: "contents", label: "Contents" },
    { key: "versions", label: "Versions" },
    { key: "readme", label: "README" },
];

const INSTALL_LABELS: Record<DetailState["install"], string> = {
    idle: "Install",
    installing: "Installing…",
    installed: "Installed",
    failed: "Retry",
};

const INSTALL_CLASSES: Record<DetailState["install"], string> = {
    idle: "cta cta-lead",
    installing: "cta cta-busy",
    installed: "cta cta-done",
    failed: "cta cta-failed",
};

/** Draws one facet's detail screen. */
export function renderDetail(
    data: DetailData,
    state: DetailState,
    actions: DetailActions,
    doc: PanelDocument = requireDocument(),
): PanelFragment {
    const fragment = doc.createDocumentFragment();

    const head = element(doc, "header", "detail-head");
    head.appendChild(button(doc, "back", "← Registry", () => actions.back()));
    fragment.appendChild(head);

    const card = element(doc, "article", "card detail-card");

    const top = element(doc, "div", "facet-top");
    const heading = element(doc, "div", "facet-heading");
    heading.appendChild(element(doc, "h1", "facet-name-static", data.facet));
    if (data.version !== "") {
        heading.appendChild(element(doc, "span", "facet-version", data.version));
    }
    if (data.visibility === "private") {
        heading.appendChild(element(doc, "span", "badge-private", "private"));
    }
    top.appendChild(heading);

    const install = button(doc, INSTALL_CLASSES[state.install], INSTALL_LABELS[state.install], () => actions.install());
    if (state.install === "installing" || state.install === "installed") {
        install.setAttribute("disabled", "true");
    }
    top.appendChild(install);
    card.appendChild(top);

    const by = [data.publisher === "" ? "" : `by ${data.publisher}`, data.published]
        .filter(part => part !== "")
        .join(" · ");
    if (by !== "") {
        card.appendChild(element(doc, "p", "facet-by", by));
    }
    if (data.description !== "") {
        card.appendChild(element(doc, "p", "facet-desc", data.description));
    }
    if (state.error !== undefined) {
        card.appendChild(element(doc, "p", "facet-error", state.error));
    }

    const chips = element(doc, "div", "facet-chips");
    for (const count of data.counts) {
        chips.appendChild(assetChip(doc, count.type, count.label));
    }
    card.appendChild(chips);

    const tabs = element(doc, "div", "tabs");
    tabs.setAttribute("role", "tablist");
    for (const tab of TABS) {
        const on = state.tab === tab.key;
        const node = button(doc, on ? "tab tab-on" : "tab", tab.label, () => actions.tab(tab.key));
        node.setAttribute("role", "tab");
        node.setAttribute("aria-selected", on ? "true" : "false");
        tabs.appendChild(node);
    }
    card.appendChild(tabs);

    const body = element(doc, "div", "tab-body");
    body.setAttribute("role", "tabpanel");
    if (state.tab === "contents") {
        renderContents(doc, body, data);
    } else if (state.tab === "versions") {
        renderVersions(doc, body, data, actions);
    } else {
        renderReadme(doc, body, data, state);
    }
    card.appendChild(body);

    fragment.appendChild(card);
    return fragment;
}

function renderContents(doc: PanelDocument, body: PanelElement, data: DetailData): void {
    if (data.assets.length === 0) {
        body.appendChild(element(doc, "p", "empty", "This facet lists no assets."));
        return;
    }
    for (const asset of data.assets) {
        const row = element(doc, "div", "inside-row");
        row.appendChild(assetChip(doc, asset.type, asset.type));
        row.appendChild(element(doc, "span", "inside-name", asset.name));
        if (asset.detail !== "") {
            row.appendChild(element(doc, "span", "inside-detail", asset.detail));
        }
        body.appendChild(row);
    }
}

function renderVersions(doc: PanelDocument, body: PanelElement, data: DetailData, actions: DetailActions): void {
    if (data.versions.length === 0) {
        body.appendChild(element(doc, "p", "empty", "The registry did not return a version list."));
        return;
    }
    for (const version of data.versions) {
        const row = element(doc, "div", "version-row");
        const open = button(doc, "version-name", version, () => actions.version(version));
        row.appendChild(open);
        if (version === data.version) {
            row.appendChild(element(doc, "span", "version-note", "showing"));
        }
        body.appendChild(row);
    }
}

function renderReadme(doc: PanelDocument, body: PanelElement, data: DetailData, state: DetailState): void {
    if (state.loadingReadme) {
        body.appendChild(element(doc, "p", "empty", "Reading the README…"));
        return;
    }
    const readme = state.readmes[data.version];
    if (readme === undefined) {
        body.appendChild(element(doc, "p", "empty", "Nothing read yet."));
        return;
    }
    if (readme.file === "") {
        body.appendChild(element(doc, "p", "empty", "This version ships no README."));
        return;
    }
    body.appendChild(element(doc, "p", "readme-file", readme.file));
    // Deliberately not rendered as Markdown: the text is published content from
    // anywhere, and a pre block shows it faithfully without ever becoming markup.
    body.appendChild(element(doc, "pre", "readme", readme.text));
    if (readme.truncated) {
        body.appendChild(element(doc, "p", "empty", "Cut here — the file is longer than the panel will show."));
    }
}
