// How one operation went.
//
// Every facet tool eventually reports the same four things: which facet, which
// operation, whether it worked, and a sentence about it. This module turns any
// tool result into those four fields and draws them two ways — as a strip along
// the top of a console screen, which is where they normally belong, and as a
// standalone card for a result that arrives before any screen has been read.
//
// Nothing here trusts its input: every value is type-checked before it is kept,
// and unusable input yields a sane empty result rather than an exception.

import {
    asRecord,
    element,
    firstString,
    isRecord,
    textParts,
    asJsonObject,
    assetTypeClass,
    requireDocument,
    type PanelDocument,
    type PanelElement,
    type PanelFragment,
} from "./dom.js";

/** How an operation ended. Anything unrecognized is treated as a success. */
export type PanelStatus = "success" | "error" | "pending";

export const STATUS_LABELS: Record<PanelStatus, string> = {
    success: "Succeeded",
    error: "Failed",
    pending: "In progress",
};

/** Status colors, matching the registry's semantic tokens. */
export const STATUS_COLORS: Record<PanelStatus, string> = {
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

/** Everything the result needs, already normalized and type-checked. */
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
 * The readable text of a result, joined.
 *
 * A part that parses as a JSON object is the payload, not prose, so it is left
 * out. That is the whole point: there is one line for the message and it has to
 * read like a sentence, never like a dump of the result envelope. The lifecycle
 * tools put their full payload in a text part alongside the summary, so without
 * this rule a result that missed the summary would show that dump.
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

/**
 * Unwraps the `{ ok: true, data } | { ok: false, error }` envelope the lifecycle
 * tools write into their text part.
 *
 * This is the fallback path — normally the summary in `structuredContent` says
 * everything needed. It matters when that summary doesn't arrive (an older
 * build, a host or proxy that drops it), because without unwrapping, the only
 * thing left to show would be the serialized envelope itself.
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
 * into the fields a result is drawn from.
 *
 * There are three places a fact can come from, and they are tried in that order.
 * First `structuredContent`, which is where the tools put the summary written
 * for exactly this purpose — facet, operation, status, message, assets. Then the
 * text payload, unwrapped from its `{ ok, ... }` envelope. Last, the plain prose
 * of the result, which is all the auth tools send.
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

function headerCell(doc: PanelDocument, label: string): PanelElement {
    const cell = element(doc, "th", undefined, label);
    cell.setAttribute("scope", "col");
    return cell;
}

export function assetTable(doc: PanelDocument, assets: PanelAsset[]): PanelElement {
    const table = element(doc, "table", "assets");
    table.appendChild(element(doc, "caption", undefined, "Assets"));

    const head = element(doc, "thead");
    const headRow = element(doc, "tr");
    // The three headers the presentation skill mandates, word for word, so the
    // panel and the prose fallback describe a result the same way.
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
 * The line the console keeps along the top: what just ran, and how it went.
 *
 * This is the console's answer to the old standalone card. The facts are the
 * same ones; what changes is that they sit above a screen showing the state
 * they produced, instead of replacing it.
 */
export function renderStrip(data: PanelData, doc: PanelDocument = requireDocument()): PanelElement {
    const strip = element(doc, "div", `strip strip-${data.status}`);
    strip.setAttribute("role", "status");

    strip.appendChild(element(doc, "span", "dot"));
    strip.appendChild(element(doc, "span", "strip-op", data.operation));
    if (data.facet !== "Unknown facet") {
        strip.appendChild(element(doc, "span", "strip-facet", data.facet));
    }
    strip.appendChild(
        element(doc, "span", "strip-message", data.message ?? STATUS_LABELS[data.status]),
    );
    return strip;
}

/**
 * The standalone card, for a result that arrived with no screen behind it.
 *
 * Pure: it touches nothing outside the fragment it returns, which is what makes
 * it testable without a browser. Pass a document explicitly when there is no
 * global one.
 */
export function renderResult(data: unknown, doc: PanelDocument = requireDocument()): PanelFragment {
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

/** Swaps a container's contents for a freshly rendered card. */
export function mount(container: PanelElement, data: unknown, doc: PanelDocument = requireDocument()): void {
    // Assigning empty text drops every child without parsing anything.
    container.textContent = "";
    container.appendChild(renderResult(data, doc));
}
