// The Installed screen: what this project has, and what to do about it.
//
// One row per facet, drawn from `facets.json` and `facets.lock` rather than from
// any single command's output — see ../project.ts for why. Three things can be
// done from here, and each is a real CLI run: update a facet to a version the
// registry confirmed exists, remove one, and repair a project whose two files
// disagree.
//
// The rule the screen holds to: it never offers an action it cannot prove is
// available. An Update button appears only after the registry has been asked
// what the latest version is, and only when that version differs from the one
// the lockfile holds.

import {
    asRecord,
    assetChip,
    button,
    element,
    firstString,
    requireDocument,
    stringOr,
    type PanelDocument,
    type PanelElement,
    type PanelFragment,
} from "./dom.js";
import type { GalleryCount } from "./gallery.js";

/** One row of the installed list. */
export interface InstalledFacet {
    name: string;
    scope: string;
    shortName: string;
    declared: string;
    version: string;
    origin: string;
    from: string;
    installed: boolean;
    counts: GalleryCount[];
}

/** One way the manifest and the lockfile disagree. */
export interface DriftEntry {
    name: string;
    reason: string;
    detail: string;
}

/** Everything the screen draws about the project. */
export interface InstalledData {
    project: string;
    directory: string;
    /** Where that path came from, as the header shows it. */
    rootLabel: string;
    declared: boolean;
    locked: boolean;
    facets: InstalledFacet[];
    drift: DriftEntry[];
}

/** How far a row's removal has got. */
export type RemoveState = "idle" | "confirming" | "removing" | "removed";

/** Everything the screen draws that isn't the project itself. */
export interface InstalledState {
    /** Removal progress, keyed by facet name. */
    removes: Record<string, RemoveState>;
    /** Facets currently being updated. */
    updating: Record<string, boolean>;
    /** Latest versions the registry confirmed, keyed by facet name. */
    latest: Record<string, string>;
    /** True while the registry is being asked about every row. */
    checking: boolean;
    /** True while a repair is running. */
    repairing: boolean;
    /** Per-row failures, keyed by facet name. */
    errors: Record<string, string>;
}

export function emptyInstalledState(): InstalledState {
    return { removes: {}, updating: {}, latest: {}, checking: false, repairing: false, errors: {} };
}

/** What the screen asks the console to do. */
export interface InstalledActions {
    /** Ask the registry what the latest version of every registry facet is. */
    check(): void;
    update(facet: InstalledFacet, version: string): void;
    confirmRemove(facet: InstalledFacet): void;
    cancelRemove(facet: InstalledFacet): void;
    remove(facet: InstalledFacet): void;
    /** Put back a facet just removed, at the version it was on. */
    undo(facet: InstalledFacet): void;
    repair(): void;
    browse(): void;
}

function toCount(value: unknown): GalleryCount | undefined {
    const record = asRecord(value);
    const label = firstString(record.label);
    return label === undefined ? undefined : { type: firstString(record.type) ?? "unknown", label };
}

function toInstalledFacet(value: unknown): InstalledFacet | undefined {
    const record = asRecord(value);
    const name = firstString(record.name);
    if (name === undefined) {
        return undefined;
    }
    return {
        name,
        scope: stringOr(record.scope),
        shortName: firstString(record.shortName) ?? name,
        declared: stringOr(record.declared),
        version: stringOr(record.version),
        origin: stringOr(record.origin),
        from: stringOr(record.from),
        installed: record.installed === true,
        counts: Array.isArray(record.counts)
            ? record.counts.map(toCount).filter((count): count is GalleryCount => count !== undefined)
            : [],
    };
}

function toDrift(value: unknown): DriftEntry | undefined {
    const record = asRecord(value);
    const detail = firstString(record.detail);
    return detail === undefined
        ? undefined
        : { name: stringOr(record.name), reason: stringOr(record.reason), detail };
}

/** Reads a project read, or returns undefined when this isn't one. */
export function toInstalledData(value: unknown): InstalledData | undefined {
    const outer = asRecord(value);
    const structured = asRecord(outer.structuredContent);
    const source = firstString(structured.kind) === "installed"
        ? structured
        : firstString(outer.kind) === "installed"
          ? outer
          : undefined;
    if (source === undefined) {
        return undefined;
    }
    return {
        project: stringOr(source.project),
        directory: stringOr(source.directory),
        rootLabel: stringOr(source.rootLabel),
        declared: source.declared === true,
        locked: source.locked === true,
        facets: Array.isArray(source.facets)
            ? source.facets.map(toInstalledFacet).filter((facet): facet is InstalledFacet => facet !== undefined)
            : [],
        drift: Array.isArray(source.drift)
            ? source.drift.map(toDrift).filter((entry): entry is DriftEntry => entry !== undefined)
            : [],
    };
}

/** Draws the installed list. */
export function renderInstalled(
    data: InstalledData,
    state: InstalledState,
    actions: InstalledActions,
    doc: PanelDocument = requireDocument(),
): PanelFragment {
    const fragment = doc.createDocumentFragment();

    const head = element(doc, "header", "gallery-head");
    head.appendChild(element(doc, "p", "operation", "Installed here"));
    // The path alone was never enough. When the root is wrong — a scratch
    // directory the host chose — the screen used to look like a project with
    // nothing in it, so the header says where this was read from and how.
    head.appendChild(element(doc, "p", "gallery-count", data.rootLabel === "" ? data.directory : data.rootLabel));
    fragment.appendChild(head);

    if (data.drift.length > 0) {
        fragment.appendChild(driftBanner(doc, data, state, actions));
    }

    if (data.facets.length === 0) {
        const empty = element(doc, "div", "empty-state");
        empty.appendChild(
            element(
                doc,
                "p",
                "empty",
                data.declared
                    ? "This project declares no facets yet."
                    : "There is no facets.json here, so nothing is installed.",
            ),
        );
        empty.appendChild(button(doc, "cta cta-lead", "Browse the registry", () => actions.browse()));
        fragment.appendChild(empty);
        return fragment;
    }

    const bar = element(doc, "div", "filters");
    const check = button(
        doc,
        state.checking ? "filter filter-busy" : "filter",
        state.checking ? "Checking the registry…" : "Check for updates",
        () => actions.check(),
    );
    if (state.checking) {
        check.setAttribute("disabled", "true");
    }
    bar.appendChild(check);
    fragment.appendChild(bar);

    const list = element(doc, "div", "installed-list");
    for (const facet of data.facets) {
        list.appendChild(installedRow(doc, facet, state, actions));
    }
    fragment.appendChild(list);

    const foot = element(doc, "footer", "installed-foot");
    foot.appendChild(
        element(
            doc,
            "p",
            "foot-note",
            "Every action here runs the facet CLI, and writes facets.json and facets.lock.",
        ),
    );
    foot.appendChild(button(doc, "facet-toggle", "Browse the registry", () => actions.browse()));
    fragment.appendChild(foot);

    return fragment;
}

function driftBanner(
    doc: PanelDocument,
    data: InstalledData,
    state: InstalledState,
    actions: InstalledActions,
): PanelElement {
    const banner = element(doc, "div", "drift");
    banner.setAttribute("role", "status");

    const title = data.drift.length === 1
        ? "facets.json and facets.lock disagree"
        : `facets.json and facets.lock disagree in ${data.drift.length} places`;
    banner.appendChild(element(doc, "p", "drift-title", title));

    for (const entry of data.drift) {
        banner.appendChild(element(doc, "p", "drift-detail", entry.detail));
    }

    banner.appendChild(
        element(doc, "p", "drift-detail", "Repair runs facet install, which brings the project back to what facets.json asks for."),
    );

    const repair = button(
        doc,
        state.repairing ? "cta cta-busy" : "cta cta-lead",
        state.repairing ? "Repairing…" : "Repair",
        () => actions.repair(),
    );
    if (state.repairing) {
        repair.setAttribute("disabled", "true");
    }
    banner.appendChild(repair);
    return banner;
}

function installedRow(
    doc: PanelDocument,
    facet: InstalledFacet,
    state: InstalledState,
    actions: InstalledActions,
): PanelElement {
    const removal = state.removes[facet.name] ?? "idle";
    const row = element(doc, "article", removal === "removed" ? "facet-row facet-row-gone" : "facet-row");

    // One line per facet: what it is on the left, what can be done on the right.
    const main = element(doc, "div", "row-main");

    const heading = element(doc, "div", "facet-heading");
    const name = element(doc, "span", "row-name");
    if (facet.scope !== "") {
        name.appendChild(element(doc, "span", "row-scope", facet.scope));
    }
    name.appendChild(doc.createTextNode(facet.shortName));
    heading.appendChild(name);
    heading.appendChild(
        element(doc, "span", "facet-version", facet.installed ? facet.version : `${facet.declared} · not installed`),
    );
    main.appendChild(heading);

    const chips = element(doc, "div", "facet-chips");
    for (const count of facet.counts) {
        chips.appendChild(assetChip(doc, count.type, count.label));
    }
    if (facet.origin !== "" && facet.origin !== "registry") {
        chips.appendChild(element(doc, "span", "row-origin", facet.from === "" ? facet.origin : `${facet.origin} · ${facet.from}`));
    }
    main.appendChild(chips);
    row.appendChild(main);

    row.appendChild(rowActions(doc, facet, state, actions, removal));

    const failure = state.errors[facet.name];
    if (failure !== undefined) {
        row.appendChild(element(doc, "p", "facet-error", failure));
    }
    return row;
}

function rowActions(
    doc: PanelDocument,
    facet: InstalledFacet,
    state: InstalledState,
    actions: InstalledActions,
    removal: RemoveState,
): PanelElement {
    const box = element(doc, "div", "row-actions");

    if (removal === "removed") {
        box.appendChild(element(doc, "span", "row-note", "Removed"));
        box.appendChild(
            button(doc, "cta", "Undo", () => actions.undo(facet)),
        );
        return box;
    }

    if (removal === "confirming") {
        box.appendChild(
            element(doc, "span", "row-note", `Remove ${facet.name} and uninstall its assets?`),
        );
        box.appendChild(button(doc, "cta cta-failed", "Remove", () => actions.remove(facet)));
        box.appendChild(button(doc, "cta", "Cancel", () => actions.cancelRemove(facet)));
        return box;
    }

    if (removal === "removing") {
        box.appendChild(element(doc, "span", "row-note", "Removing…"));
        return box;
    }

    const latest = state.latest[facet.name];
    if (state.updating[facet.name] === true) {
        box.appendChild(element(doc, "span", "row-note", "Updating…"));
    } else if (!facet.installed) {
        box.appendChild(element(doc, "span", "row-note", "Repair installs this."));
    } else if (latest !== undefined && latest !== facet.version) {
        box.appendChild(button(doc, "cta cta-lead", `Update to ${latest}`, () => actions.update(facet, latest)));
    } else if (latest !== undefined) {
        box.appendChild(element(doc, "span", "row-note", "Up to date"));
    }

    box.appendChild(button(doc, "cta", "Remove", () => actions.confirmRemove(facet)));
    return box;
}
