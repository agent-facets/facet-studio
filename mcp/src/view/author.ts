// The Authoring screen: the facet you are writing.
//
// This one edits. Every field and every asset row is wired to `facet_modify`,
// which is the same command a person would run by hand, so the screen never
// writes anything itself and never gets ahead of what the CLI actually did — a
// save is followed by a fresh read of `facet.json`, and what comes back is what
// is drawn.
//
// Two limits are stated on the screen rather than hidden. The CLI can set a
// facet's private flag but has no operation to clear it, so making a facet
// private is a one-way door and is confirmed as one. And there is no publish
// tool on this server, so the screen shows how to publish rather than offering a
// button that cannot work.

import {
    assetChip,
    asRecord,
    button,
    element,
    field,
    firstString,
    payloadOf,
    requireDocument,
    stringOr,
    type PanelDocument,
    type PanelElement,
    type PanelFragment,
} from "./dom.js";

/** One asset the manifest declares. */
export interface AuthorAsset {
    type: string;
    name: string;
    detail: string;
}

/** A built archive sitting in dist/. */
export interface BuiltArchive {
    file: string;
    size: string;
}

/** Everything the screen draws about the facet being authored. */
export interface AuthorData {
    present: boolean;
    directory: string;
    name: string;
    version: string;
    description: string;
    visibility: string;
    assets: AuthorAsset[];
    built: BuiltArchive[];
    problem?: string;
}

/** How a run of verify or build is going. */
export type RunState = "idle" | "running" | "passed" | "failed";

/** The fields a person can have half-typed. */
export interface AuthorDrafts {
    name?: string;
    version?: string;
    description?: string;
}

export interface AuthorState {
    drafts: AuthorDrafts;
    saving: boolean;
    verify: RunState;
    build: RunState;
    /** The last thing an action here had to say, in the CLI's words. */
    message?: string;
    /** The asset whose description is open for editing. */
    editing: string | null;
    assetDraft: string;
    /** The asset waiting on a remove confirmation. */
    removing: string | null;
    busyAsset: string | null;
    /** True once someone has asked to make the facet private, before confirming. */
    confirmingPrivate: boolean;
    newAssetType: string;
    newAssetName: string;
}

export function emptyAuthorState(): AuthorState {
    return {
        drafts: {},
        saving: false,
        verify: "idle",
        build: "idle",
        editing: null,
        assetDraft: "",
        removing: null,
        busyAsset: null,
        confirmingPrivate: false,
        newAssetType: "skill",
        newAssetName: "",
    };
}

/** What the screen asks the console to do. */
export interface AuthorActions {
    draft(field: keyof AuthorDrafts, value: string): void;
    save(): void;
    revert(): void;
    bump(part: "patch" | "minor" | "major"): void;
    askPrivate(): void;
    makePrivate(): void;
    cancelPrivate(): void;
    verify(): void;
    build(): void;
    editAsset(asset: AuthorAsset): void;
    draftAsset(value: string): void;
    saveAsset(asset: AuthorAsset): void;
    cancelAsset(): void;
    askRemoveAsset(asset: AuthorAsset): void;
    removeAsset(asset: AuthorAsset): void;
    cancelRemoveAsset(): void;
    chooseType(type: string): void;
    nameAsset(value: string): void;
    addAsset(): void;
}

function toAsset(value: unknown): AuthorAsset | undefined {
    const record = asRecord(value);
    const name = firstString(record.name);
    return name === undefined
        ? undefined
        : { name, type: firstString(record.type) ?? "unknown", detail: stringOr(record.detail) };
}

function toArchive(value: unknown): BuiltArchive | undefined {
    const record = asRecord(value);
    const file = firstString(record.file);
    return file === undefined ? undefined : { file, size: stringOr(record.size) };
}

/** Reads a manifest read, or returns undefined when this isn't one. */
export function toAuthorData(value: unknown): AuthorData | undefined {
    const source = payloadOf(value, "author");
    if (source === undefined) {
        return undefined;
    }
    const problem = firstString(source.problem);
    return {
        present: source.present === true,
        directory: stringOr(source.directory),
        name: stringOr(source.name),
        version: stringOr(source.version),
        description: stringOr(source.description),
        visibility: stringOr(source.visibility),
        assets: Array.isArray(source.assets)
            ? source.assets.map(toAsset).filter((asset): asset is AuthorAsset => asset !== undefined)
            : [],
        built: Array.isArray(source.built)
            ? source.built.map(toArchive).filter((archive): archive is BuiltArchive => archive !== undefined)
            : [],
        ...(problem === undefined ? {} : { problem }),
    };
}

/** The next version along, or undefined when the current one isn't a plain x.y.z. */
export function bumpVersion(version: string, part: "patch" | "minor" | "major"): string | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
    if (match === null) {
        return undefined;
    }
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (part === "major") {
        return `${major + 1}.0.0`;
    }
    if (part === "minor") {
        return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
}

/** The value a field should show: the draft if there is one, else the manifest's. */
function shown(data: AuthorData, state: AuthorState, key: keyof AuthorDrafts): string {
    return state.drafts[key] ?? data[key];
}

const RUN_LABELS: Record<RunState, { verify: string; build: string }> = {
    idle: { verify: "Verify", build: "Build archive" },
    running: { verify: "Verifying…", build: "Building…" },
    passed: { verify: "Verified", build: "Built" },
    failed: { verify: "Verify failed — retry", build: "Build failed — retry" },
};

const ASSET_TYPES: readonly { key: string; label: string }[] = [
    { key: "skill", label: "Skill" },
    { key: "agent", label: "Agent" },
    { key: "command", label: "Command" },
];

/** Draws the authoring screen. */
export function renderAuthor(
    data: AuthorData,
    state: AuthorState,
    actions: AuthorActions,
    doc: PanelDocument = requireDocument(),
): PanelFragment {
    const fragment = doc.createDocumentFragment();

    const head = element(doc, "header", "gallery-head");
    head.appendChild(element(doc, "p", "operation", "Authoring"));
    head.appendChild(element(doc, "p", "gallery-count", data.directory));
    fragment.appendChild(head);

    if (!data.present) {
        const empty = element(doc, "div", "empty-state");
        empty.appendChild(element(doc, "p", "empty", "There is no facet.json here, so there is nothing to author."));
        empty.appendChild(
            element(doc, "p", "foot-note", "Run facet_create to scaffold one, then this screen fills in."),
        );
        fragment.appendChild(empty);
        return fragment;
    }

    if (data.problem !== undefined) {
        const broken = element(doc, "div", "drift");
        broken.appendChild(element(doc, "p", "drift-title", "facet.json cannot be read"));
        broken.appendChild(element(doc, "p", "drift-detail", data.problem));
        fragment.appendChild(broken);
        return fragment;
    }

    if (state.message !== undefined) {
        fragment.appendChild(element(doc, "p", "author-message", state.message));
    }

    fragment.appendChild(manifestCard(doc, data, state, actions));
    fragment.appendChild(assetsCard(doc, data, state, actions));
    fragment.appendChild(shipCard(doc, data, state, actions));

    return fragment;
}

function manifestCard(
    doc: PanelDocument,
    data: AuthorData,
    state: AuthorState,
    actions: AuthorActions,
): PanelElement {
    const card = element(doc, "article", "card");
    card.appendChild(element(doc, "p", "operation", "facet.json"));

    card.appendChild(field(doc, "facet-field-name", "name", shown(data, state, "name"), value => actions.draft("name", value)));
    card.appendChild(
        field(doc, "facet-field-version", "version", shown(data, state, "version"), value => actions.draft("version", value)),
    );

    const bumps = element(doc, "div", "bumps");
    for (const part of ["patch", "minor", "major"] as const) {
        const next = bumpVersion(shown(data, state, "version"), part);
        const label = next === undefined ? part : `${part} · ${next}`;
        const node = button(doc, "filter", label, () => actions.bump(part));
        if (next === undefined) {
            node.setAttribute("disabled", "true");
        }
        bumps.appendChild(node);
    }
    card.appendChild(bumps);

    card.appendChild(
        field(doc, "facet-field-description", "description", shown(data, state, "description"), value => actions.draft("description", value), {
            multiline: true,
        }),
    );

    card.appendChild(visibilityRow(doc, data, state, actions));

    // Save and Revert are always offered. Gating them on whether a field has
    // been edited would mean redrawing as someone types, and a redraw takes the
    // field they are typing into out from under them. Saving nothing does
    // nothing, and reverting nothing puts the manifest's own values back.
    const actionsRow = element(doc, "div", "row-actions");
    const save = button(doc, state.saving ? "cta cta-busy" : "cta cta-lead", state.saving ? "Saving…" : "Save", () =>
        actions.save(),
    );
    if (state.saving) {
        save.setAttribute("disabled", "true");
    }
    actionsRow.appendChild(save);
    actionsRow.appendChild(button(doc, "cta", "Revert", () => actions.revert()));
    card.appendChild(actionsRow);

    return card;
}

function visibilityRow(
    doc: PanelDocument,
    data: AuthorData,
    state: AuthorState,
    actions: AuthorActions,
): PanelElement {
    const row = element(doc, "div", "row-actions");
    row.appendChild(element(doc, "span", "field-label", "visibility"));
    row.appendChild(element(doc, "span", data.visibility === "private" ? "badge-private" : "row-note", data.visibility));

    if (data.visibility === "private") {
        row.appendChild(element(doc, "span", "row-note", "A private facet stays private."));
        return row;
    }
    if (state.confirmingPrivate) {
        row.appendChild(
            element(doc, "span", "row-note", "The CLI can set the private flag but has no operation to clear it. Make it private?"),
        );
        row.appendChild(button(doc, "cta cta-failed", "Make private", () => actions.makePrivate()));
        row.appendChild(button(doc, "cta", "Cancel", () => actions.cancelPrivate()));
        return row;
    }
    row.appendChild(button(doc, "cta", "Make private", () => actions.askPrivate()));
    return row;
}

function assetsCard(
    doc: PanelDocument,
    data: AuthorData,
    state: AuthorState,
    actions: AuthorActions,
): PanelElement {
    const card = element(doc, "article", "card");
    const head = element(doc, "div", "facet-top");
    head.appendChild(element(doc, "p", "operation", "Assets"));
    head.appendChild(
        element(doc, "span", "gallery-count", `${data.assets.length} ${data.assets.length === 1 ? "asset" : "assets"}`),
    );
    card.appendChild(head);

    for (const asset of data.assets) {
        card.appendChild(assetRow(doc, asset, state, actions));
    }
    if (data.assets.length === 0) {
        card.appendChild(element(doc, "p", "empty", "This facet declares no assets yet."));
    }

    card.appendChild(newAssetRow(doc, state, actions));
    return card;
}

function assetRow(
    doc: PanelDocument,
    asset: AuthorAsset,
    state: AuthorState,
    actions: AuthorActions,
): PanelElement {
    const row = element(doc, "div", "asset-row");

    const top = element(doc, "div", "asset-head");
    const label = element(doc, "div", "asset-label");
    label.appendChild(assetChip(doc, asset.type, asset.type));
    label.appendChild(element(doc, "span", "inside-name", asset.name));
    top.appendChild(label);

    if (state.editing !== asset.name) {
        top.appendChild(assetControls(doc, asset, state, actions));
    }
    row.appendChild(top);

    if (state.editing === asset.name) {
        row.appendChild(
            field(doc, `facet-asset-${asset.name}`, "description", state.assetDraft, value => actions.draftAsset(value), {
                multiline: true,
            }),
        );
        const editing = element(doc, "div", "row-actions");
        editing.appendChild(button(doc, "cta cta-lead", "Save", () => actions.saveAsset(asset)));
        editing.appendChild(button(doc, "cta", "Cancel", () => actions.cancelAsset()));
        row.appendChild(editing);
        return row;
    }

    if (asset.detail !== "") {
        row.appendChild(element(doc, "p", "inside-detail", asset.detail));
    }
    return row;
}

/** The buttons on an asset row: describe it, or delete it once confirmed. */
function assetControls(
    doc: PanelDocument,
    asset: AuthorAsset,
    state: AuthorState,
    actions: AuthorActions,
): PanelElement {
    const controls = element(doc, "div", "row-actions");
    if (state.busyAsset === asset.name) {
        controls.appendChild(element(doc, "span", "row-note", "Working…"));
        return controls;
    }
    if (state.removing === asset.name) {
        controls.appendChild(element(doc, "span", "row-note", `Delete ${asset.name} and its file?`));
        controls.appendChild(button(doc, "cta cta-failed", "Delete", () => actions.removeAsset(asset)));
        controls.appendChild(button(doc, "cta", "Cancel", () => actions.cancelRemoveAsset()));
        return controls;
    }
    controls.appendChild(button(doc, "cta", "Describe", () => actions.editAsset(asset)));
    controls.appendChild(button(doc, "cta", "Delete", () => actions.askRemoveAsset(asset)));
    return controls;
}

function newAssetRow(doc: PanelDocument, state: AuthorState, actions: AuthorActions): PanelElement {
    const row = element(doc, "div", "asset-new");

    const types = element(doc, "div", "filters");
    for (const type of ASSET_TYPES) {
        const on = state.newAssetType === type.key;
        const node = button(doc, on ? "filter filter-on" : "filter", type.label, () => actions.chooseType(type.key));
        node.setAttribute("aria-pressed", on ? "true" : "false");
        types.appendChild(node);
    }
    row.appendChild(types);

    row.appendChild(
        field(doc, "facet-new-asset", "new asset", state.newAssetName, value => actions.nameAsset(value), {
            placeholder: "lowercase-with-dashes",
        }),
    );

    // Enabled whatever the field holds, for the same reason Save is: watching
    // the field would mean redrawing on every keystroke. Adding nothing does
    // nothing.
    row.appendChild(button(doc, "cta cta-lead", "Add", () => actions.addAsset()));
    return row;
}

function shipCard(
    doc: PanelDocument,
    data: AuthorData,
    state: AuthorState,
    actions: AuthorActions,
): PanelElement {
    const card = element(doc, "article", "card");
    card.appendChild(element(doc, "p", "operation", "Build and publish"));

    const runs = element(doc, "div", "row-actions");
    const verify = button(
        doc,
        state.verify === "running" ? "cta cta-busy" : state.verify === "passed" ? "cta cta-done" : "cta cta-lead",
        RUN_LABELS[state.verify].verify,
        () => actions.verify(),
    );
    if (state.verify === "running") {
        verify.setAttribute("disabled", "true");
    }
    runs.appendChild(verify);

    const build = button(
        doc,
        state.build === "running" ? "cta cta-busy" : state.build === "passed" ? "cta cta-done" : "cta",
        RUN_LABELS[state.build].build,
        () => actions.build(),
    );
    if (state.build === "running") {
        build.setAttribute("disabled", "true");
    }
    runs.appendChild(build);
    card.appendChild(runs);

    for (const archive of data.built) {
        const row = element(doc, "div", "inside-row");
        row.appendChild(element(doc, "span", "inside-name", `dist/${archive.file}`));
        row.appendChild(element(doc, "span", "inside-detail", archive.size));
        card.appendChild(row);
    }
    if (data.built.length === 0) {
        card.appendChild(element(doc, "p", "empty", "Nothing built yet."));
    }

    // No publish button, because there is no publish tool behind it. Publishing
    // is irreversible — a version can never be replaced — so the screen points at
    // the command rather than pretending.
    card.appendChild(
        element(
            doc,
            "p",
            "foot-note",
            "Publishing runs from the CLI: facet publish, or the /facet-publish command. This server has no publish tool, because a published version can never be replaced.",
        ),
    );
    return card;
}
