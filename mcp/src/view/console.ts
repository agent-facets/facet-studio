// The console: one surface that stays put.
//
// A facet operation is rarely the last one. You search, you install, you look at
// what you now have, you remove the thing you didn't want. So the panel is not a
// card per call — it is a console with three places to be (the registry, this
// project, the facet you are writing), and a tool result updates whichever of
// them it is about rather than replacing the surface.
//
// That is the whole reason for the strip along the top: the facts a result card
// used to carry — which operation, how it went, in the CLI's own words — are
// still there, but they sit above a screen showing the state they produced. A
// removal that reports success beside a list still containing the facet is the
// failure this arrangement exists to prevent.
//
// Every call out to the server goes through {@link ConsolePorts}, which is what
// lets the whole thing be driven in a test with no browser and no host: click a
// button, assert what redrew.

import { button, element, requireDocument, type PanelDocument, type PanelElement } from "./dom.js";
import { renderStrip, type PanelData } from "./result.js";
import {
    BROWSE_LIMIT,
    emptyGalleryState,
    renderGallery,
    toGalleryData as readGallery,
    type GalleryActions,
    type GalleryData,
    type GalleryFacet,
    type GalleryState,
} from "./gallery.js";
import {
    emptyDetailState,
    renderDetail,
    toDetailData as readDetail,
    type DetailActions,
    type DetailData,
    type DetailState,
    type DetailTab,
    type ReadmeData,
} from "./detail.js";
import {
    emptyInstalledState,
    renderInstalled,
    toInstalledData as readInstalled,
    type InstalledActions,
    type InstalledData,
    type InstalledFacet,
    type InstalledState,
} from "./installed.js";
import {
    emptyAuthorState,
    renderAuthor,
    toAuthorData as readAuthor,
    bumpVersion,
    type AuthorActions,
    type AuthorAsset,
    type AuthorData,
    type AuthorDrafts,
    type AuthorState,
} from "./author.js";

/** Where the console is. Detail is reached from the registry, not from the nav. */
export type Screen = "registry" | "detail" | "installed" | "author";

/** How a mutation went, as the console cares about it. */
export interface Outcome {
    ok: boolean;
    message?: string;
}

/** Arguments for one `facet_modify` run, in the CLI's own vocabulary. */
export interface ModifyArgs {
    target: "skill" | "agent" | "command" | "facet";
    name?: string;
    add?: boolean;
    remove?: boolean;
    description?: string;
    facetName?: string;
    version?: string;
    private?: boolean;
}

/** Everything the console asks the server to do. */
export interface ConsolePorts {
    browse(query: string, limit?: number, cursor?: string): Promise<GalleryData | undefined>;
    detail(name: string, version?: string): Promise<DetailData | undefined>;
    readme(name: string, version: string): Promise<ReadmeData | undefined>;
    project(): Promise<InstalledData | undefined>;
    manifest(): Promise<AuthorData | undefined>;
    add(name: string, version?: string): Promise<Outcome>;
    remove(name: string): Promise<Outcome>;
    /** `facet install` — what Repair runs. */
    install(): Promise<Outcome>;
    verify(): Promise<Outcome>;
    build(): Promise<Outcome>;
    modify(args: ModifyArgs): Promise<Outcome>;
}

export interface ConsoleState {
    screen: Screen;
    /**
     * Whether the Authoring tab is offered at all. Someone browsing or managing
     * installs has no facet.json open and no use for it, so it stays out of the
     * nav until an authoring result actually arrives — creating, modifying,
     * building, verifying, or reading a manifest is what earns it a place.
     */
    authoring: boolean;
    /** The last operation's outcome, shown along the top. */
    strip?: PanelData;
    /** The screen currently fetching its own data, if any. */
    loading: Screen | null;
    registry?: GalleryData;
    gallery: GalleryState;
    detail?: DetailData;
    detailState: DetailState;
    installed?: InstalledData;
    installedState: InstalledState;
    author?: AuthorData;
    authorState: AuthorState;
}

export function emptyConsoleState(): ConsoleState {
    return {
        screen: "registry",
        authoring: false,
        loading: null,
        gallery: emptyGalleryState(),
        detailState: emptyDetailState(),
        installedState: emptyInstalledState(),
        authorState: emptyAuthorState(),
    };
}

/** The three places the nav can take you, and what each one is called. */
const NAV: readonly { key: Screen; label: string }[] = [
    { key: "registry", label: "Registry" },
    { key: "installed", label: "Installed" },
    { key: "author", label: "Authoring" },
];

/** Which nav entry is lit for a given screen. Detail belongs to the registry. */
function navFor(screen: Screen): Screen {
    return screen === "detail" ? "registry" : screen;
}

/** What the console shell asks for. */
export interface ConsoleActions {
    go(screen: Screen): void;
}

/** Draws the shell: the nav, the outcome strip, and whatever screen is showing. */
export function renderShell(
    state: ConsoleState,
    actions: ConsoleActions,
    screen: PanelElement,
    doc: PanelDocument = requireDocument(),
): PanelElement {
    const shell = element(doc, "div", "console");

    const nav = element(doc, "nav", "nav");
    nav.setAttribute("aria-label", "Facet Studio");
    const lit = navFor(state.screen);
    const offered = state.authoring ? NAV : NAV.filter(entry => entry.key !== "author");
    for (const entry of offered) {
        const on = lit === entry.key;
        const node = button(doc, on ? "nav-item nav-on" : "nav-item", entry.label, () => actions.go(entry.key));
        node.setAttribute("aria-current", on ? "page" : "false");
        nav.appendChild(node);
    }
    shell.appendChild(nav);

    if (state.strip !== undefined) {
        shell.appendChild(renderStrip(state.strip, doc));
    }

    shell.appendChild(screen);
    return shell;
}

/**
 * Owns the console's state and redraws the container whenever it changes.
 *
 * Every method here follows the same shape: change the state, redraw, do the
 * slow thing, change the state again, redraw. Nothing waits on a network call
 * before the screen reflects that it started.
 */
export class ConsoleController {
    private state: ConsoleState = emptyConsoleState();

    constructor(
        private readonly container: PanelElement,
        private readonly ports: ConsolePorts,
        private readonly doc: PanelDocument,
    ) {}

    /** The state a test wants to assert on. */
    snapshot(): ConsoleState {
        return this.state;
    }

    private set(patch: Partial<ConsoleState>): void {
        this.state = { ...this.state, ...patch };
        this.render();
    }

    /**
     * Records a change without redrawing.
     *
     * Every redraw builds the tree again, which means the element a person is
     * typing into is replaced under their cursor. So a keystroke updates the
     * draft and stops there; the field on screen already shows what they typed,
     * and the next real change — a save, a bump, a fresh read — draws it back in
     * from the state.
     */
    private keep(patch: Partial<ConsoleState>): void {
        this.state = { ...this.state, ...patch };
    }

    // -----------------------------------------------------------------------
    // Taking delivery of a tool result
    // -----------------------------------------------------------------------

    /**
     * Shows what a tool result is about.
     *
     * A read (browse, detail, project, manifest) replaces that screen's data and
     * moves to it. Anything else is an operation: its outcome goes in the strip,
     * and the screen it affected is re-read so what is on show is what is true.
     */
    show(result: unknown, outcome: PanelData): void {
        // A read is answered by the screen it fills, so it earns no line in the
        // strip. Only an operation does — the strip is for things that happened,
        // not for things that were looked up.
        const gallery = readGallery(result);
        if (gallery !== undefined) {
            this.set({
                screen: "registry",
                registry: gallery,
                gallery: { ...emptyGalleryState(), filter: gallery.type ?? "all", draft: gallery.query },
                loading: null,
            });
            return;
        }
        const detail = readDetail(result);
        if (detail !== undefined) {
            this.set({ screen: "detail", detail, detailState: emptyDetailState(), loading: null });
            return;
        }
        const installed = readInstalled(result);
        if (installed !== undefined) {
            this.set({
                screen: "installed",
                installed,
                installedState: { ...emptyInstalledState(), latest: this.state.installedState.latest },
                loading: null,
            });
            return;
        }
        const author = readAuthor(result);
        if (author !== undefined) {
            this.set({ screen: "author", authoring: true, author, authorState: emptyAuthorState(), loading: null });
            return;
        }

        // Not a read: an operation, or an auth result that belongs to no screen.
        // The strip carries it, and the screen it touched catches up.
        this.set({ strip: outcome });
        void this.refreshFor(outcome.operation);
    }

    /**
     * Which screen a tool's name implies, so the console lands there and the
     * right read is redone.
     *
     * This is the recovery path for a read that failed as much as the follow-up
     * for an operation that ran. When the host's model calls facet_browse with
     * arguments the schema refuses, the error goes on the strip — but the user
     * asked about the registry, so the Registry screen opens and fetches itself
     * with arguments known to be good, instead of stranding them on whatever
     * screen happened to be up.
     */
    private async refreshFor(operation: string): Promise<void> {
        const label = operation.toLowerCase();
        if (/(browse|detail|readme)/.test(label)) {
            this.set({ screen: "registry" });
            await this.loadRegistry(this.state.registry?.query ?? "");
            return;
        }
        if (/(add|remove|update|install|list|project)/.test(label)) {
            this.set({ screen: "installed" });
            await this.loadInstalled();
            return;
        }
        if (/(create|modify|build|verify|publish|manifest)/.test(label)) {
            this.set({ screen: "author", authoring: true });
            await this.loadAuthor();
        }
    }

    // -----------------------------------------------------------------------
    // Moving between screens
    // -----------------------------------------------------------------------

    go(screen: Screen): void {
        // Arriving at the Authoring screen by any road puts its tab in the nav.
        this.set({ screen, ...(screen === "author" ? { authoring: true } : {}) });
        if (screen === "registry" && this.state.registry === undefined) {
            void this.loadRegistry("");
            return;
        }
        // A row left marked Removed is a promise that Undo is still available.
        // Coming back to the screen is where that promise ends, so the list is
        // read again rather than showing a facet that is no longer there.
        if (screen === "installed" && (this.state.installed === undefined || this.hasRemovedRows())) {
            void this.loadInstalled();
            return;
        }
        if (screen === "author" && this.state.author === undefined) {
            void this.loadAuthor();
        }
    }

    /** Opens whichever screen makes sense first, and fetches it. */
    start(screen: Screen = "installed"): void {
        this.go(screen);
    }

    private hasRemovedRows(): boolean {
        return Object.values(this.state.installedState.removes).includes("removed");
    }

    private async loadRegistry(query: string): Promise<void> {
        this.set({ loading: "registry" });
        // The panel pages locally, so it asks for the server's whole cap and
        // lets the pager walk it, rather than fetching the six-row default.
        const data = await this.ports.browse(query, BROWSE_LIMIT).catch(() => undefined);
        // The draft survives the reset: the box should keep showing the words
        // that produced the result on screen.
        this.set({
            loading: null,
            ...(data === undefined
                ? {}
                : {
                      registry: data,
                      gallery: {
                          ...emptyGalleryState(),
                          filter: data.type ?? "all",
                          draft: query,
                          nextCursor: data.nextCursor,
                      },
                  }),
        });
    }

    private async loadMore(): Promise<void> {
        if (this.state.registry === undefined || this.state.gallery.nextCursor === undefined) {
            return;
        }
        this.set({ gallery: { ...this.state.gallery, loadingMore: true, loadMoreError: undefined } });
        let data: GalleryData | undefined;
        let message: string | undefined;
        try {
            data = await this.ports.browse(this.state.registry.query, BROWSE_LIMIT, this.state.gallery.nextCursor);
        } catch (error) {
            message = reasonFor(error);
        }
        if (data === undefined) {
            // On error, restore the button and keep the cursor so the same click
            // retries — the reason sits alongside it, same as an install failure.
            this.set({
                gallery: { ...this.state.gallery, loadingMore: false, loadMoreError: message ?? "Loading more did not complete." },
            });
            return;
        }

        // Append new results to existing ones, deduping by facet name (first occurrence wins).
        const existingNames = new Set(this.state.registry.results.map(f => f.name));
        const newFacets = data.results.filter(f => !existingNames.has(f.name));

        this.set({
            loading: null,
            registry: {
                ...this.state.registry,
                results: [...this.state.registry.results, ...newFacets],
            },
            gallery: { ...this.state.gallery, loadingMore: false, loadMoreError: undefined, nextCursor: data.nextCursor },
        });
    }

    private async loadInstalled(): Promise<void> {
        this.set({ loading: "installed" });
        const data = await this.ports.project().catch(() => undefined);
        this.set({
            loading: null,
            ...(data === undefined
                ? {}
                : { installed: data, installedState: { ...emptyInstalledState(), latest: this.state.installedState.latest } }),
        });
    }

    private async loadAuthor(): Promise<void> {
        this.set({ loading: "author" });
        const data = await this.ports.manifest().catch(() => undefined);
        this.set({ loading: null, ...(data === undefined ? {} : { author: data, authorState: emptyAuthorState() }) });
    }

    // -----------------------------------------------------------------------
    // The registry screen
    // -----------------------------------------------------------------------

    private galleryActions(): GalleryActions {
        return {
            // A new filter starts from the first page — page numbers only mean
            // anything against the list they were counted on. The cursor stays:
            // filtering by asset type happens here in the panel, over rows that
            // are already in hand, so the search the server ran is unchanged and
            // its next page is still the right one to ask for. Only a new search
            // makes a cursor worthless.
            filter: type => this.set({ gallery: { ...this.state.gallery, filter: type, page: 0 } }),
            open: facet => void this.openDetail(facet.name, facet.version),
            install: facet => void this.installFromGallery(facet),
            update: (facet, version) => void this.updateFromGallery(facet, version),
            // Kept, not set: the box on screen already shows the keystroke, and
            // a redraw here would replace the input under the user's cursor.
            draft: value => this.keep({ gallery: { ...this.state.gallery, draft: value } }),
            search: () => void this.loadRegistry(this.state.gallery.draft.trim()),
            page: next => this.set({ gallery: { ...this.state.gallery, page: Math.max(0, next) } }),
            more: () => void this.loadMore(),
        };
    }

    private async openDetail(name: string, version?: string): Promise<void> {
        this.set({ screen: "detail", loading: "detail", detailState: this.detailStateFor(name) });
        const data = await this.ports.detail(name, version).catch(() => undefined);
        if (data === undefined) {
            this.set({ loading: null, screen: "registry" });
            return;
        }
        this.set({ loading: null, detail: data });
    }

    /**
     * What the install button on a freshly opened detail screen starts as.
     *
     * The gallery already worked this out for the card the user just clicked,
     * and the answer doesn't change on the way to the detail screen — without
     * this, a row reading "Installed" would offer a fresh Install one click
     * later. Same order of precedence the cards use: an install run in this
     * session is the freshest thing there is, then the server's snapshot of the
     * project, and a facet the current results don't list starts from idle.
     */
    private detailStateFor(name: string): DetailState {
        const session = this.state.gallery.installs[name];
        if (session !== undefined) {
            return { ...emptyDetailState(), install: session };
        }
        const row = this.state.registry?.results.find(facet => facet.name === name);
        if (row?.installed === undefined) {
            return emptyDetailState();
        }
        return { ...emptyDetailState(), install: "installed" };
    }

    private async installFromGallery(facet: GalleryFacet): Promise<void> {
        await this.runGalleryAdd(facet.name, facet.version === "" ? undefined : facet.version);
    }

    /**
     * Installs over a copy the server already reported as stale.
     *
     * Same machinery as a fresh install — the row's session state, once set,
     * is what the card renders from, so it masks the now-out-of-date server
     * snapshot without this ever touching `facet.installed` itself.
     */
    private async updateFromGallery(facet: GalleryFacet, version: string): Promise<void> {
        await this.runGalleryAdd(facet.name, version);
    }

    private async runGalleryAdd(name: string, version: string | undefined): Promise<void> {
        const current = this.state.gallery.installs[name] ?? "idle";
        if (current === "installing" || current === "installed") {
            return;
        }
        this.setInstall(name, "installing");
        const outcome = await this.ports.add(name, version).catch(error => ({ ok: false, message: reasonFor(error) }));
        this.setInstall(name, outcome.ok ? "installed" : "failed", outcome.ok ? undefined : outcome.message);
        if (outcome.ok) {
            // The Installed screen is now out of date, whether or not anyone is
            // looking at it, so it gets re-read rather than left to go stale.
            await this.loadInstalled();
        }
    }

    private setInstall(name: string, status: GalleryState["installs"][string], message?: string): void {
        const errors = { ...this.state.gallery.errors };
        if (message === undefined) {
            delete errors[name];
        } else {
            errors[name] = message;
        }
        this.set({ gallery: { ...this.state.gallery, installs: { ...this.state.gallery.installs, [name]: status }, errors } });
    }

    // -----------------------------------------------------------------------
    // The detail screen
    // -----------------------------------------------------------------------

    private detailActions(): DetailActions {
        return {
            back: () => this.go("registry"),
            version: version => void this.openDetail(this.state.detail?.facet ?? "", version),
            tab: tab => void this.openTab(tab),
            install: () => void this.installFromDetail(),
        };
    }

    private async openTab(tab: DetailTab): Promise<void> {
        this.set({ detailState: { ...this.state.detailState, tab } });
        const facet = this.state.detail;
        if (tab !== "readme" || facet === undefined || this.state.detailState.readmes[facet.version] !== undefined) {
            return;
        }
        this.set({ detailState: { ...this.state.detailState, tab, loadingReadme: true } });
        const readme = await this.ports.readme(facet.facet, facet.version).catch(() => undefined);
        this.set({
            detailState: {
                ...this.state.detailState,
                loadingReadme: false,
                readmes: {
                    ...this.state.detailState.readmes,
                    [facet.version]: readme ?? { file: "", text: "", truncated: false },
                },
            },
        });
    }

    private async installFromDetail(): Promise<void> {
        const facet = this.state.detail;
        if (facet === undefined || this.state.detailState.install === "installing") {
            return;
        }
        this.set({ detailState: { ...this.state.detailState, install: "installing", error: undefined } });
        const outcome = await this.ports
            .add(facet.facet, facet.version === "" ? undefined : facet.version)
            .catch(error => ({ ok: false, message: reasonFor(error) }));
        this.set({
            detailState: {
                ...this.state.detailState,
                install: outcome.ok ? "installed" : "failed",
                ...(outcome.ok ? {} : { error: outcome.message ?? "The install did not complete." }),
            },
        });
        if (outcome.ok) {
            await this.loadInstalled();
        }
    }

    // -----------------------------------------------------------------------
    // The installed screen
    // -----------------------------------------------------------------------

    private installedActions(): InstalledActions {
        return {
            browse: () => this.go("registry"),
            check: () => void this.checkForUpdates(),
            update: (facet, version) => void this.update(facet, version),
            confirmRemove: facet => this.setRemove(facet.name, "confirming"),
            cancelRemove: facet => this.setRemove(facet.name, "idle"),
            remove: facet => void this.remove(facet),
            undo: facet => void this.undo(facet),
            repair: () => void this.repair(),
        };
    }

    private setRemove(name: string, state: InstalledState["removes"][string]): void {
        this.set({
            installedState: { ...this.state.installedState, removes: { ...this.state.installedState.removes, [name]: state } },
        });
    }

    private setRowError(name: string, message?: string): void {
        const errors = { ...this.state.installedState.errors };
        if (message === undefined) {
            delete errors[name];
        } else {
            errors[name] = message;
        }
        this.set({ installedState: { ...this.state.installedState, errors } });
    }

    /**
     * Asks the registry what the latest version of each registry-sourced facet
     * is, so an Update button can name a version that exists.
     *
     * Sequential on purpose: this is a handful of small reads against a public
     * API, and a burst of them from a panel is a worse neighbour than a wait.
     */
    private async checkForUpdates(): Promise<void> {
        const facets = (this.state.installed?.facets ?? []).filter(
            facet => facet.installed && (facet.origin === "registry" || facet.origin === ""),
        );
        this.set({ installedState: { ...this.state.installedState, checking: true } });
        const latest: Record<string, string> = { ...this.state.installedState.latest };
        for (const facet of facets) {
            const data = await this.ports.detail(facet.name).catch(() => undefined);
            if (data !== undefined && data.version !== "") {
                latest[facet.name] = data.version;
            }
        }
        this.set({ installedState: { ...this.state.installedState, checking: false, latest } });
    }

    private async update(facet: InstalledFacet, version: string): Promise<void> {
        this.set({
            installedState: {
                ...this.state.installedState,
                updating: { ...this.state.installedState.updating, [facet.name]: true },
            },
        });
        const outcome = await this.ports.add(facet.name, version).catch(error => ({ ok: false, message: reasonFor(error) }));
        this.set({
            installedState: {
                ...this.state.installedState,
                updating: { ...this.state.installedState.updating, [facet.name]: false },
            },
        });
        if (!outcome.ok) {
            this.setRowError(facet.name, outcome.message ?? "The update did not complete.");
            return;
        }
        this.setRowError(facet.name);
        await this.loadInstalled();
    }

    private async remove(facet: InstalledFacet): Promise<void> {
        this.setRemove(facet.name, "removing");
        const outcome = await this.ports.remove(facet.name).catch(error => ({ ok: false, message: reasonFor(error) }));
        if (!outcome.ok) {
            this.setRemove(facet.name, "idle");
            this.setRowError(facet.name, outcome.message ?? "The removal did not complete.");
            return;
        }
        // The row stays on screen, marked removed, so Undo has something to sit
        // on. The list itself is re-read only when the person moves on.
        this.setRemove(facet.name, "removed");
        this.setRowError(facet.name);
    }

    /** Puts a removed facet back at the version it was on. */
    private async undo(facet: InstalledFacet): Promise<void> {
        this.setRemove(facet.name, "removing");
        const outcome = await this.ports
            .add(facet.name, facet.version === "" ? undefined : facet.version)
            .catch(error => ({ ok: false, message: reasonFor(error) }));
        if (!outcome.ok) {
            this.setRemove(facet.name, "removed");
            this.setRowError(facet.name, outcome.message ?? "It could not be put back.");
            return;
        }
        await this.loadInstalled();
    }

    private async repair(): Promise<void> {
        this.set({ installedState: { ...this.state.installedState, repairing: true } });
        const outcome = await this.ports.install().catch(error => ({ ok: false, message: reasonFor(error) }));
        this.set({ installedState: { ...this.state.installedState, repairing: false } });
        if (!outcome.ok) {
            this.setRowError("", outcome.message ?? "The repair did not complete.");
            return;
        }
        await this.loadInstalled();
    }

    // -----------------------------------------------------------------------
    // The authoring screen
    // -----------------------------------------------------------------------

    private authorActions(): AuthorActions {
        const patch = (author: Partial<AuthorState>): void =>
            this.set({ authorState: { ...this.state.authorState, ...author } });

        return {
            // Typed into, so recorded without a redraw — see keep().
            draft: (name, value) =>
                this.keep({ authorState: { ...this.state.authorState, drafts: { ...this.state.authorState.drafts, [name]: value } } }),
            revert: () => patch({ drafts: {} }),
            save: () => void this.saveFields(),
            bump: part => {
                const current = this.state.authorState.drafts.version ?? this.state.author?.version ?? "";
                const next = bumpVersion(current, part);
                if (next !== undefined) {
                    patch({ drafts: { ...this.state.authorState.drafts, version: next } });
                }
            },
            askPrivate: () => patch({ confirmingPrivate: true }),
            cancelPrivate: () => patch({ confirmingPrivate: false }),
            makePrivate: () => void this.runModify({ target: "facet", private: true }, { confirmingPrivate: false }),
            verify: () => void this.runCheck("verify"),
            build: () => void this.runCheck("build"),
            editAsset: asset => patch({ editing: asset.name, assetDraft: asset.detail }),
            draftAsset: value => this.keep({ authorState: { ...this.state.authorState, assetDraft: value } }),
            cancelAsset: () => patch({ editing: null, assetDraft: "" }),
            saveAsset: asset =>
                void this.runModify(
                    { target: assetTarget(asset.type), name: asset.name, description: this.state.authorState.assetDraft },
                    { editing: null, assetDraft: "", busyAsset: asset.name },
                ),
            askRemoveAsset: asset => patch({ removing: asset.name }),
            cancelRemoveAsset: () => patch({ removing: null }),
            removeAsset: asset =>
                void this.runModify(
                    { target: assetTarget(asset.type), name: asset.name, remove: true },
                    { removing: null, busyAsset: asset.name },
                ),
            chooseType: type => patch({ newAssetType: type }),
            nameAsset: value => this.keep({ authorState: { ...this.state.authorState, newAssetName: value } }),
            addAsset: () => {
                const name = this.state.authorState.newAssetName.trim();
                if (name === "") {
                    return;
                }
                void this.runModify(
                    { target: assetTarget(this.state.authorState.newAssetType), name, add: true },
                    { newAssetName: "" },
                );
            },
        };
    }

    /** Saves whichever manifest fields were actually edited, and nothing else. */
    private async saveFields(): Promise<void> {
        const author = this.state.author;
        const drafts = this.state.authorState.drafts;
        if (author === undefined) {
            return;
        }
        const args: ModifyArgs = { target: "facet" };
        if (drafts.name !== undefined && drafts.name !== author.name) {
            args.facetName = drafts.name;
        }
        if (drafts.version !== undefined && drafts.version !== author.version) {
            args.version = drafts.version;
        }
        if (drafts.description !== undefined && drafts.description !== author.description) {
            args.description = drafts.description;
        }
        if (args.facetName === undefined && args.version === undefined && args.description === undefined) {
            return;
        }
        await this.runModify(args, { saving: true });
    }

    /**
     * Runs one `facet_modify` and re-reads the manifest afterwards.
     *
     * The re-read is the point: nothing on this screen is drawn from what we
     * asked for, only from what the file says once the CLI has been through it.
     */
    private async runModify(args: ModifyArgs, before: Partial<AuthorState>): Promise<void> {
        this.set({ authorState: { ...this.state.authorState, ...before, message: undefined } });
        const outcome = await this.ports.modify(args).catch(error => ({ ok: false, message: reasonFor(error) }));
        if (!outcome.ok) {
            this.set({
                authorState: {
                    ...this.state.authorState,
                    saving: false,
                    busyAsset: null,
                    message: outcome.message ?? "The edit did not complete.",
                },
            });
            return;
        }
        await this.loadAuthor();
    }

    private async runCheck(which: "verify" | "build"): Promise<void> {
        this.set({ authorState: { ...this.state.authorState, [which]: "running", message: undefined } });
        const outcome = await (which === "verify" ? this.ports.verify() : this.ports.build()).catch(error => ({
            ok: false,
            message: reasonFor(error),
        }));
        this.set({
            authorState: {
                ...this.state.authorState,
                [which]: outcome.ok ? "passed" : "failed",
                ...(outcome.message === undefined ? {} : { message: outcome.message }),
            },
        });
        if (outcome.ok && which === "build") {
            // A build writes into dist/, which the screen lists.
            await this.loadAuthor();
        }
    }

    // -----------------------------------------------------------------------
    // Drawing
    // -----------------------------------------------------------------------

    render(): void {
        const doc = this.doc;
        const screen = element(doc, "div", "screen");

        if (this.state.loading === this.state.screen) {
            screen.appendChild(element(doc, "p", "waiting", "Reading…"));
        } else if (this.state.screen === "registry") {
            appendTo(screen, this.state.registry === undefined
                ? element(doc, "p", "waiting", "Nothing searched yet.")
                : renderGallery(this.state.registry, this.state.gallery, this.galleryActions(), doc));
        } else if (this.state.screen === "detail") {
            appendTo(screen, this.state.detail === undefined
                ? element(doc, "p", "waiting", "No facet opened.")
                : renderDetail(this.state.detail, this.state.detailState, this.detailActions(), doc));
        } else if (this.state.screen === "installed") {
            appendTo(screen, this.state.installed === undefined
                ? element(doc, "p", "waiting", "The project has not been read yet.")
                : renderInstalled(this.state.installed, this.state.installedState, this.installedActions(), doc));
        } else {
            appendTo(screen, this.state.author === undefined
                ? element(doc, "p", "waiting", "No facet.json read yet.")
                : renderAuthor(this.state.author, this.state.authorState, this.authorActions(), doc));
        }

        this.container.textContent = "";
        this.container.appendChild(renderShell(this.state, { go: next => this.go(next) }, screen, doc));
    }
}

/** Appends a fragment or an element — both are just things with children. */
function appendTo(parent: PanelElement, child: { appendChild?: unknown }): void {
    parent.appendChild(child as object);
}

function reasonFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The `facet modify` target for an asset type, defaulting to the safe one. */
function assetTarget(type: string): "skill" | "agent" | "command" {
    return type === "agent" || type === "command" ? type : "skill";
}

export type { AuthorDrafts, AuthorAsset, InstalledData, GalleryData, DetailData, AuthorData };
