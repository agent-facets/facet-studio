// The Facet Studio result panel.
//
// One view, `ui://facet-studio/panel.html`, renders any lifecycle tool result as
// a branded card: which facet, which operation, how it went, and what assets came
// out of it. There is no framework here on purpose — plain DOM calls keep the
// bundle tiny and, more importantly, keep every untrusted string on the text side
// of the fence.
//
// Safety rule for this whole file: tool results are arbitrary JSON from anywhere,
// so **no dynamic value is ever turned into markup**. Text reaches the page only
// through `textContent` or `createTextNode`. Class names come from fixed
// allowlists, never from payload strings.

import { App, PostMessageTransport, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { ASSET_ACCENTS, buildRegistryTokensCss } from "./tokens.js";
import type { McpServer, RegisteredResource } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegistrationDeps } from "../server.js";

// The shell lives in panel.html so it stays real, editable HTML. Bun hands it to
// us as a plain string and a browser bundle inlines it, so there is no file read
// at runtime and nothing for a bundler to resolve.
// @ts-ignore -- TypeScript has no declaration for HTML text imports; Bun does.
import panelShellHtml from "./panel.html" with { type: "text" };

/** Where the resource is published, and what the host calls it. */
export const PANEL_RESOURCE_URI = "ui://facet-studio/panel.html";
export const PANEL_RESOURCE_NAME = "Facet Panel";

/** The element in panel.html that the card gets mounted into. */
export const PANEL_CONTAINER_ID = "facet-panel";

/** Placeholders in panel.html that {@link buildPanelHtml} fills in. */
export const TOKENS_MARKER = "<!--facet:tokens-->";
export const VIEW_SCRIPT_MARKER = "<!--facet:view-script-->";

// ---------------------------------------------------------------------------
// What the panel draws
// ---------------------------------------------------------------------------

/** How an operation ended. Anything unrecognized is treated as a success. */
export type PanelStatus = "success" | "error" | "pending";

const STATUS_LABELS: Record<PanelStatus, string> = {
    success: "Succeeded",
    error: "Failed",
    pending: "In progress",
};

/** Status colors, matching the registry's semantic tokens. */
const STATUS_COLORS: Record<PanelStatus, string> = {
    success: "var(--ok)",
    error: "var(--err)",
    pending: "var(--act)",
};

/** One row of the asset table. */
export interface PanelAsset {
    /** skill / agent / command / server, or whatever the tool reported. */
    type: string;
    name: string;
    detail?: string;
}

/** Everything the card needs, already normalized and type-checked. */
export interface PanelData {
    facet: string;
    operation: string;
    status: PanelStatus;
    message?: string;
    assets: PanelAsset[];
}

/** Fallbacks for fields a tool result didn't carry. */
export interface PanelDefaults {
    facet?: string;
    operation?: string;
}

// ---------------------------------------------------------------------------
// Just enough DOM to build a card
// ---------------------------------------------------------------------------
//
// The MCP server compiles without the DOM type library, so the panel describes
// the handful of DOM calls it makes rather than importing browser types. Passing
// the document in also means the renderer is a pure function that tests can drive
// without a browser.

export type PanelNode = object;

export interface PanelElement {
    className: string;
    textContent: string | null;
    appendChild(child: PanelNode): unknown;
    setAttribute(name: string, value: string): void;
}

export interface PanelFragment {
    appendChild(child: PanelNode): unknown;
}

export interface PanelDocument {
    createElement(tag: string): PanelElement;
    createTextNode(data: string): PanelNode;
    createDocumentFragment(): PanelFragment;
}

/** A document that can also find the mount point — i.e. a real browser one. */
export interface HostDocument extends PanelDocument {
    getElementById(id: string): PanelElement | null;
}

// ---------------------------------------------------------------------------
// Normalizing whatever the host hands us
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

/** First non-empty string among the candidates, or undefined. */
function firstString(...candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate;
        }
    }
    return undefined;
}

/** The `text` parts of an MCP tool result's content array, in order. */
function textParts(content: unknown): string[] {
    if (!Array.isArray(content)) {
        return [];
    }
    return content
        .map(part => (isRecord(part) && part["type"] === "text" ? part["text"] : undefined))
        .filter((text): text is string => typeof text === "string");
}

/** The object this string spells out, if it spells out an object at all. */
function asJsonObject(text: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        // Plain prose, not a payload. Fine — it becomes the message instead.
        return undefined;
    }
}

/**
 * The readable text of a result, joined.
 *
 * A part that parses as a JSON object is the payload, not prose, so it is left
 * out. That is the whole point: the card has one line for the message and it
 * has to read like a sentence, never like a dump of the result envelope. The
 * lifecycle tools put their full payload in a text part alongside the summary,
 * so without this rule a card that missed the summary would show that dump.
 */
function collectProse(content: unknown): string | undefined {
    const parts = textParts(content).filter(text => asJsonObject(text) === undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
}

/** The first text part that happens to be a JSON object. */
function parseJsonContent(content: unknown): Record<string, unknown> | undefined {
    for (const text of textParts(content)) {
        const parsed = asJsonObject(text);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
}

/** What a tool's text payload turned out to be saying. */
interface Outcome {
    /** The payload's own fields, when it carried a usable one. */
    fields?: Record<string, unknown>;
    /** The failure sentence, in the CLI's words. */
    message?: string;
    /** True only when the payload said outright that the run failed. */
    failed: boolean;
}

/**
 * Unwraps the `{ ok: true, data } | { ok: false, error }` envelope the lifecycle
 * tools write into their text part.
 *
 * This is the fallback path — normally the summary in `structuredContent` says
 * everything the card needs. It matters when that summary doesn't arrive (an
 * older build, a host or proxy that drops it), because without unwrapping, the
 * only thing left to show would be the serialized envelope itself.
 */
function readOutcome(payload: Record<string, unknown> | undefined): Outcome {
    if (payload === undefined) {
        return { failed: false };
    }
    if (typeof payload["ok"] !== "boolean") {
        // Not the envelope — some other payload object. Read it as it stands.
        return { fields: payload, failed: false };
    }
    if (payload["ok"] === true) {
        const data = payload["data"];
        return { ...(isRecord(data) ? { fields: data } : {}), failed: false };
    }
    const message = firstString(asRecord(payload["error"])["message"]);
    return { ...(message === undefined ? {} : { message }), failed: true };
}

const STATUS_ALIASES: Record<string, PanelStatus> = {
    success: "success",
    succeeded: "success",
    ok: "success",
    done: "success",
    error: "error",
    failed: "error",
    failure: "error",
    pending: "pending",
    running: "pending",
    "in-progress": "pending",
};

/** The status the fields name, or failing that, whatever the result implied. */
function readStatus(fields: Record<string, unknown>, failed: boolean): PanelStatus {
    const raw = firstString(fields["status"], fields["state"]);
    const alias = raw === undefined ? undefined : STATUS_ALIASES[raw.trim().toLowerCase()];
    if (alias !== undefined) {
        return alias;
    }
    return failed ? "error" : "success";
}

function readAssets(value: unknown): PanelAsset[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const assets: PanelAsset[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const name = firstString(entry["name"], entry["id"], entry["path"]);
        if (name === undefined) {
            continue;
        }
        const detail = firstString(entry["detail"], entry["description"], entry["summary"]);
        assets.push({
            type: firstString(entry["type"], entry["kind"]) ?? "unknown",
            name,
            ...(detail === undefined ? {} : { detail }),
        });
    }
    return assets;
}

/**
 * Turns anything — a raw MCP `CallToolResult`, a bare payload object, junk —
 * into the fields the card draws. Nothing here trusts its input: every value is
 * type-checked before it is kept, and unusable input yields a sane empty card
 * rather than an exception.
 *
 * There are three places a fact can come from, and they are tried in that
 * order. First `structuredContent`, which is where the tools put the summary
 * written for exactly this card — facet, operation, status, message, assets.
 * Then the text payload, unwrapped from its `{ ok, ... }` envelope. Last, the
 * plain prose of the result, which is all the auth tools send.
 *
 * Running this over an already-normalized {@link PanelData} leaves it unchanged,
 * so callers can hand it either shape.
 */
export function toPanelData(value: unknown, defaults: PanelDefaults = {}): PanelData {
    const top = asRecord(value);
    const structured = top["structuredContent"];
    const outcome = readOutcome(parseJsonContent(top["content"]));
    const fields = isRecord(structured) ? structured : (outcome.fields ?? top);

    const message = firstString(
        fields["message"],
        fields["error"],
        fields["summary"],
        outcome.message,
        collectProse(top["content"]),
    );

    const failed =
        top["isError"] === true || outcome.failed || fields["ok"] === false || fields["success"] === false;

    return {
        facet: firstString(fields["facet"], fields["name"], defaults.facet) ?? "Unknown facet",
        operation: firstString(fields["operation"], fields["tool"], defaults.operation) ?? "Result",
        status: readStatus(fields, failed),
        ...(message === undefined ? {} : { message }),
        assets: readAssets(fields["assets"]),
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Makes an element. `text`, when given, is the ONLY way payload data enters the
 * page — as a text node, never as markup.
 */
function element(doc: PanelDocument, tag: string, className?: string, text?: string): PanelElement {
    const node = doc.createElement(tag);
    if (className !== undefined) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/**
 * The CSS class for an asset type. Payload strings never reach a class name:
 * a type is used only if there is an accent for it, otherwise it falls back
 * to the neutral one.
 */
function assetTypeClass(type: string): string {
    const known = Object.hasOwn(ASSET_ACCENTS, type) ? type : "unknown";
    return `chip type-${known}`;
}

function headerCell(doc: PanelDocument, label: string): PanelElement {
    const cell = element(doc, "th", undefined, label);
    cell.setAttribute("scope", "col");
    return cell;
}

function assetTable(doc: PanelDocument, assets: PanelAsset[]): PanelElement {
    const table = element(doc, "table", "assets");
    table.appendChild(element(doc, "caption", undefined, "Assets"));

    const head = element(doc, "thead");
    const headRow = element(doc, "tr");
    // The three headers the presentation skill mandates, word for word, so the
    // card and the prose fallback describe a result the same way.
    for (const label of ["Type", "Name", "Description"]) {
        headRow.appendChild(headerCell(doc, label));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = element(doc, "tbody");
    for (const asset of assets) {
        const row = element(doc, "tr");

        const typeCell = element(doc, "td");
        const chip = element(doc, "span", assetTypeClass(asset.type));
        chip.appendChild(element(doc, "span", "dot"));
        chip.appendChild(doc.createTextNode(asset.type));
        typeCell.appendChild(chip);
        row.appendChild(typeCell);

        row.appendChild(element(doc, "td", "asset-name", asset.name));
        row.appendChild(element(doc, "td", "asset-detail", asset.detail ?? "—"));
        body.appendChild(row);
    }
    table.appendChild(body);

    return table;
}

/**
 * Builds the branded card for one tool result.
 *
 * Pure: it touches nothing outside the fragment it returns, which is what makes
 * it testable without a browser. Pass a document explicitly when there is no
 * global one.
 */
export function renderResult(data: unknown, doc: PanelDocument = requireDocument()): PanelFragment {
    const gallery = toGalleryData(data);
    if (gallery !== undefined) {
        return renderGallery(gallery, doc);
    }

    const panel = toPanelData(data);
    const fragment = doc.createDocumentFragment();

    const card = element(doc, "article", "card");
    fragment.appendChild(card);

    const header = element(doc, "header", "card-head");
    header.appendChild(element(doc, "p", "operation", panel.operation));
    header.appendChild(element(doc, "h1", "facet", panel.facet));
    card.appendChild(header);

    const status = element(doc, "p", `status status-${panel.status}`);
    status.appendChild(element(doc, "span", "dot"));
    status.appendChild(element(doc, "span", "status-text", STATUS_LABELS[panel.status]));
    card.appendChild(status);

    if (panel.message !== undefined) {
        card.appendChild(element(doc, "p", "message", panel.message));
    }

    card.appendChild(
        panel.assets.length > 0
            ? assetTable(doc, panel.assets)
            : element(doc, "p", "empty", "No assets reported."),
    );

    return fragment;
}

// ---------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------

/** One asset-count chip on a gallery card. */
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
    results: GalleryFacet[];
}

function toGalleryCount(value: unknown): GalleryCount | undefined {
    const record = asRecord(value);
    const label = firstString(record.label);
    const type = firstString(record.type);
    return label === undefined ? undefined : { type: type ?? "unknown", label };
}

function toGalleryFacet(value: unknown): GalleryFacet | undefined {
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
 * else falls through to the lifecycle card.
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
    return { query: firstString(source.query) ?? "", results };
}

/** Draws the browse gallery: one card per facet, in the registry's idiom. */
export function renderGallery(data: GalleryData, doc: PanelDocument = requireDocument()): PanelFragment {
    const fragment = doc.createDocumentFragment();

    const head = element(doc, "header", "gallery-head");
    head.appendChild(element(doc, "p", "operation", data.query === "" ? "Registry" : `Search · ${data.query}`));
    const count = data.results.length;
    head.appendChild(
        element(doc, "p", "gallery-count", `${count} ${count === 1 ? "facet" : "facets"}`),
    );
    fragment.appendChild(head);

    if (count === 0) {
        fragment.appendChild(
            element(
                doc,
                "p",
                "empty",
                data.query === ""
                    ? "The registry returned no facets."
                    : `Nothing matched ${data.query}.`,
            ),
        );
        return fragment;
    }

    const list = element(doc, "div", "gallery");
    for (const facet of data.results) {
        list.appendChild(galleryCard(doc, facet));
    }
    fragment.appendChild(list);
    return fragment;
}

function galleryCard(doc: PanelDocument, facet: GalleryFacet): PanelElement {
    const card = element(doc, "article", "card facet-card");

    const top = element(doc, "div", "facet-top");
    top.appendChild(element(doc, "span", "facet-name", facet.name));
    if (facet.version !== "") {
        top.appendChild(element(doc, "span", "facet-version", facet.version));
    }
    card.appendChild(top);

    if (facet.publisher !== "") {
        card.appendChild(element(doc, "p", "facet-by", `by ${facet.publisher}`));
    }
    if (facet.description !== "") {
        card.appendChild(element(doc, "p", "facet-desc", facet.description));
    }

    const foot = element(doc, "div", "facet-foot");
    const chips = element(doc, "div", "facet-chips");
    for (const entry of facet.counts) {
        const chip = element(doc, "span", assetTypeClass(entry.type));
        chip.appendChild(element(doc, "span", "dot"));
        chip.appendChild(element(doc, "span", undefined, entry.label));
        chips.appendChild(chip);
    }
    foot.appendChild(chips);
    if (facet.published !== "") {
        foot.appendChild(element(doc, "span", "facet-date", facet.published));
    }
    card.appendChild(foot);

    return card;
}

/** Swaps the container's contents for a freshly rendered card. */
export function mount(container: PanelElement, data: unknown, doc: PanelDocument = requireDocument()): void {
    // Assigning empty text drops every child without parsing anything.
    container.textContent = "";
    container.appendChild(renderResult(data, doc));
}

function requireDocument(): PanelDocument {
    const doc = (globalThis as { document?: PanelDocument }).document;
    if (doc === undefined) {
        throw new Error("No global document — pass one to renderResult() explicitly.");
    }
    return doc;
}

// ---------------------------------------------------------------------------
// View side: connect to the host and draw what it sends
// ---------------------------------------------------------------------------

type TransportArgs = ConstructorParameters<typeof PostMessageTransport>;

/**
 * Starts the panel inside the host's iframe: connect, follow the host's theme,
 * and redraw on every tool result. Returns undefined when there is no browser
 * around, which is how the server-side half of this module stays importable.
 */
export async function bootstrap(): Promise<App | undefined> {
    const globals = globalThis as { document?: HostDocument; window?: { parent: unknown } };
    const doc = globals.document;
    const win = globals.window;
    if (doc === undefined || win === undefined) {
        return undefined;
    }
    const container = doc.getElementById(PANEL_CONTAINER_ID);
    if (container === null) {
        return undefined;
    }

    const app = new App({ name: "facet-studio-panel", version: "0.3.0" });

    // Handlers go on before connect, or the first notification can slip past.
    app.ontoolresult = result => {
        const toolName = app.getHostContext()?.toolInfo?.tool.name;
        mount(container, toPanelData(result, { operation: toolName ?? "Result" }), doc);
    };
    app.onhostcontextchanged = context => {
        if (context.theme !== undefined) {
            applyDocumentTheme(context.theme);
        }
    };

    await app.connect(new PostMessageTransport(win.parent as TransportArgs[0], win.parent as TransportArgs[1]));

    const theme = app.getHostContext()?.theme;
    if (theme !== undefined) {
        applyDocumentTheme(theme);
    }
    return app;
}

// Self-start in a browser; stay inert everywhere else (tests, the MCP server).
if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
    void bootstrap().catch((error: unknown) => {
        console.error("Facet Studio panel failed to start:", error);
    });
}

// ---------------------------------------------------------------------------
// Server side: build the HTML and publish it as a resource
// ---------------------------------------------------------------------------

export interface BuildPanelHtmlOptions {
    /**
     * The bundled view script, inlined into the page as a module. Omitted by
     * default because bundling belongs to the build step, not to this file.
     */
    viewScript?: string;
    /** Override the shell. Defaults to panel.html. */
    shell?: string;
}

/** Guards against a value that would close the tag it is being nested inside. */
function assertNoClosingTag(value: string, tag: string): void {
    if (new RegExp(`</\\s*${tag}`, "i").test(value)) {
        throw new Error(`Refusing to inline a ${tag} block that closes its own tag.`);
    }
}

function requireMarker(shell: string, marker: string): void {
    if (!shell.includes(marker)) {
        throw new Error(`panel.html is missing the ${marker} placeholder.`);
    }
}

/**
 * The per-status and per-asset-type colors the card needs, as CSS variables.
 *
 * These sit on top of the registry token sheet: the tokens define the palette,
 * this maps it onto the panel's own status and asset names. Asset chips get the
 * registry's tinted-pill treatment — a translucent accent fill, a stronger accent
 * border, and text mixed toward the ink so it stays readable on the fill.
 */
function buildBrandCss(): string {
    const statusVars = Object.entries(STATUS_COLORS).map(([name, color]) => `  --status-${name}: ${color};`);
    const assetVars = Object.entries(ASSET_ACCENTS).map(([name, color]) => `  --asset-${name}: ${color};`);
    const statusRules = Object.keys(STATUS_COLORS).map(
        name => `.status-${name} .dot { background: var(--status-${name}); }`,
    );
    const assetRules = Object.keys(ASSET_ACCENTS).flatMap(name => [
        `.type-${name} .dot { background: var(--asset-${name}); }`,
        `.type-${name} {`,
        `  background: color-mix(in oklab, var(--asset-${name}) 14%, transparent);`,
        `  border-color: color-mix(in oklab, var(--asset-${name}) 36%, transparent);`,
        `  color: color-mix(in oklab, var(--asset-${name}) 82%, var(--ink));`,
        `}`,
    ]);

    return [
        ":root {",
        ...statusVars,
        ...assetVars,
        "  --asset-unknown: var(--ink-faint);",
        "}",
        ...statusRules,
        ...assetRules,
        ".type-unknown .dot { background: var(--asset-unknown); }",
    ].join("\n");
}

/**
 * Assembles the page the host loads: the panel.html shell with the brand token
 * stylesheet inlined, plus the view script when a build step supplies one.
 *
 * Everything is inline. The page asks for no fonts, no scripts and no images
 * from anywhere, so it renders under the strictest host CSP.
 */
export function buildPanelHtml(options: BuildPanelHtmlOptions = {}): string {
    const shell = options.shell ?? (panelShellHtml as string);
    requireMarker(shell, TOKENS_MARKER);
    requireMarker(shell, VIEW_SCRIPT_MARKER);

    const css = `${buildRegistryTokensCss()}\n${buildBrandCss()}`;
    assertNoClosingTag(css, "style");
    const styleBlock = `<style>\n${css}\n</style>`;

    let scriptBlock = "";
    if (options.viewScript !== undefined) {
        assertNoClosingTag(options.viewScript, "script");
        scriptBlock = `<script type="module">\n${options.viewScript}\n</script>`;
    }

    // Function replacements: a `$&` in the script would otherwise be expanded.
    return shell.replace(TOKENS_MARKER, () => styleBlock).replace(VIEW_SCRIPT_MARKER, () => scriptBlock);
}

/**
 * Makes the server able to answer resource requests before anything is
 * registered. Call it while building the server, before `connect()`.
 *
 * The SDK only installs the resource handlers — and only advertises the
 * `resources` capability — the first time a resource is registered, and it
 * refuses to add capabilities once a transport is attached. Since the panel is
 * registered after the handshake (that is when we know whether the host renders
 * UI at all), registering a throwaway resource up front and dropping it
 * immediately is what keeps the real registration possible. Exactly the same
 * move server.ts already makes for tools.
 */
export function primeResourceListing(server: McpServer): void {
    server
        .registerResource("facet_studio_probe", "ui://facet-studio/probe", {}, () => ({ contents: [] }))
        .remove();
}

/**
 * Publishes the panel as an MCP Apps resource.
 *
 * Plugs into the server's registration seam. Hosts that can't render UI get
 * nothing — there is no point advertising a view they cannot open. The server
 * must have called {@link primeResourceListing} at build time, or this throws.
 */
export function registerPanel(
    server: McpServer,
    deps: RegistrationDeps,
    options: BuildPanelHtmlOptions = {},
): RegisteredResource | undefined {
    if (!deps.supportsUi) {
        return undefined;
    }

    return registerAppResource(
        server,
        PANEL_RESOURCE_NAME,
        PANEL_RESOURCE_URI,
        {
            description: "Branded card view for Facet Studio lifecycle tool results.",
            // Empty allowlists say it out loud: this view talks to nobody.
            _meta: { ui: { csp: { resourceDomains: [], connectDomains: [] } } },
        },
        () => ({
            contents: [
                {
                    uri: PANEL_RESOURCE_URI,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: buildPanelHtml(options),
                },
            ],
        }),
    );
}
