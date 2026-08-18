// The Facet Studio panel.
//
// One view, `ui://facet-studio/panel.html`, is published to the host and every
// facet tool points at it. What it renders is the console in ./console.ts: three
// screens over the registry, this project, and the facet being authored, with a
// strip along the top saying how the last operation went.
//
// This file owns the edges rather than the drawing. It starts the console inside
// the host's iframe and wires its ports to real tool calls; it assembles the page
// the host loads; and it publishes that page as an MCP Apps resource. The screens
// themselves are in ./gallery, ./detail, ./installed and ./author, and none of
// them knows the host exists.
//
// Safety rule for the whole view: tool results are arbitrary JSON from anywhere,
// so **no dynamic value is ever turned into markup**. Text reaches the page only
// through `textContent` or `createTextNode`, and class names come from fixed
// allowlists, never from payload strings. See ./dom.ts.

import { App, PostMessageTransport, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { ASSET_ACCENTS, buildRegistryTokensCss } from "./tokens.js";
import { firstText, isErrorResult, type HostDocument, type PanelDocument, type PanelElement } from "./dom.js";
import { STATUS_COLORS, toPanelData } from "./result.js";
import { ConsoleController, type ConsolePorts, type ModifyArgs, type Outcome } from "./console.js";
import { toGalleryData } from "./gallery.js";
import { toDetailData, toReadmeData } from "./detail.js";
import { toInstalledData } from "./installed.js";
import { toAuthorData } from "./author.js";
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

/** The element in panel.html that the console gets mounted into. */
export const PANEL_CONTAINER_ID = "facet-panel";

/** Placeholders in panel.html that {@link buildPanelHtml} fills in. */
export const TOKENS_MARKER = "<!--facet:tokens-->";
export const VIEW_SCRIPT_MARKER = "<!--facet:view-script-->";

// The parts of the view other modules and the tests reach for. Re-exported here
// so `view/panel.js` stays the one import for anything about the panel.
export {
    assetTypeClass,
    element,
    firstText,
    type HostDocument,
    type PanelDocument,
    type PanelElement,
    type PanelFragment,
    type PanelNode,
} from "./dom.js";
export {
    mount,
    renderResult,
    renderStrip,
    toPanelData,
    type PanelAsset,
    type PanelData,
    type PanelDefaults,
    type PanelStatus,
} from "./result.js";
export { toGalleryData, renderGallery, type GalleryData, type GalleryFacet } from "./gallery.js";
export { toDetailData, toReadmeData, renderDetail, type DetailData } from "./detail.js";
export { toInstalledData, renderInstalled, type InstalledData } from "./installed.js";
export { toAuthorData, renderAuthor, type AuthorData } from "./author.js";
export { ConsoleController, renderShell, type ConsolePorts, type ConsoleState, type Screen } from "./console.js";

// ---------------------------------------------------------------------------
// View side: connect to the host and draw what it sends
// ---------------------------------------------------------------------------

type TransportArgs = ConstructorParameters<typeof PostMessageTransport>;

/** A tool result, read as the outcome of an operation. */
function outcomeOf(result: unknown): Outcome {
    return isErrorResult(result)
        ? { ok: false, ...(firstText(result) === undefined ? {} : { message: firstText(result) as string }) }
        : { ok: true };
}

/**
 * The console's calls back into the server.
 *
 * Every one of them is a tool a person could run by hand — `facet_add` for an
 * install, `facet_modify` for an edit — so the panel drives the real lifecycle
 * rather than a private path of its own.
 */
export function hostPorts(app: Pick<App, "callServerTool">): ConsolePorts {
    const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
        app.callServerTool({ name, arguments: args });

    return {
        browse: async query => toGalleryData(await call("facet_browse", query === "" ? {} : { query })),
        detail: async (name, version) =>
            toDetailData(await call("facet_detail", version === undefined ? { name } : { name, version })),
        readme: async (name, version) => toReadmeData(await call("facet_readme", { name, version })),
        project: async () => toInstalledData(await call("facet_project")),
        manifest: async () => toAuthorData(await call("facet_manifest")),
        add: async (name, version) => outcomeOf(await call("facet_add", version === undefined ? { name } : { name, version })),
        remove: async name => outcomeOf(await call("facet_remove", { name })),
        install: async () => outcomeOf(await call("facet_install")),
        verify: async () => outcomeOf(await call("facet_verify")),
        build: async () => outcomeOf(await call("facet_build")),
        modify: async (args: ModifyArgs) => outcomeOf(await call("facet_modify", { ...args })),
    };
}

/**
 * Starts the console inside the host's iframe: connect, follow the host's theme,
 * and hand every tool result to the controller. Returns undefined when there is
 * no browser around, which is how the server-side half of this module stays
 * importable.
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

    const app = new App({ name: "facet-studio-panel", version: "0.5.0" });
    const console_ = new ConsoleController(container, hostPorts(app), doc);

    // Handlers go on before connect, or the first notification can slip past.
    app.ontoolresult = result => {
        const toolName = app.getHostContext()?.toolInfo?.tool.name;
        console_.show(result, toPanelData(result, { operation: toolName ?? "Result" }));
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

    // The tool that opened the panel delivers its own result through
    // `ontoolresult`; this is for the case where nothing has arrived yet, so the
    // console still comes up on something real rather than an empty frame.
    console_.start("installed");
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
 * The per-status and per-asset-type colors the screens need, as CSS variables.
 *
 * These sit on top of the registry token sheet: the tokens define the palette,
 * this maps it onto the panel's own status and asset names. Asset chips get the
 * registry's tinted-pill treatment — a translucent accent fill, a stronger accent
 * border, and text mixed toward the ink so it stays readable on the fill.
 */
function buildBrandCss(): string {
    const statusVars = Object.entries(STATUS_COLORS).map(([name, color]) => `  --status-${name}: ${color};`);
    const assetVars = Object.entries(ASSET_ACCENTS).map(([name, color]) => `  --asset-${name}: ${color};`);
    const statusRules = Object.keys(STATUS_COLORS).flatMap(name => [
        `.status-${name} .dot { background: var(--status-${name}); }`,
        `.strip-${name} .dot { background: var(--status-${name}); }`,
        `.strip-${name} { border-color: color-mix(in oklab, var(--status-${name}) 40%, var(--line)); }`,
    ]);
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
            description: "The Facet Studio console: browse the registry, manage what this project has installed, and author a facet.",
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

/** Kept for callers that only want to know whether a container exists. */
export type { PanelElement as PanelMountPoint };
