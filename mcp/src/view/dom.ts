// The handful of DOM calls the console makes, and the rules about using them.
//
// Two things live here. The first is a description of a document narrow enough
// that a test can supply one without a browser, which is what keeps every screen
// a pure function of its data. The second is the safety rule the whole view
// depends on: **no dynamic value is ever turned into markup**. Text reaches the
// page through `textContent` or `createTextNode` and nowhere else, and class
// names come from fixed allowlists rather than from payload strings.
//
// The MCP server compiles without the DOM type library, so the shapes below
// describe the calls rather than importing browser types.

import { ASSET_ACCENTS } from "./tokens.js";

export const PANEL_PAYLOAD_KEY = "facet-studio/panel";

export type PanelNode = object;

export interface PanelElement {
    className: string;
    textContent: string | null;
    /** Present on form controls. The Authoring screen reads its fields back through it. */
    value?: string;
    appendChild(child: PanelNode): unknown;
    setAttribute(name: string, value: string): void;
    /**
     * Present on real elements; the interactive screens wire their buttons with
     * it. The event is optional so a test can fire a handler with nothing; the
     * search box reads `key` from it to submit on Enter.
     */
    addEventListener?(type: string, handler: (event?: { key?: string }) => void): void;
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

export function requireDocument(): PanelDocument {
    const doc = (globalThis as { document?: PanelDocument }).document;
    if (doc === undefined) {
        throw new Error("No global document — pass one to the renderer explicitly.");
    }
    return doc;
}

/**
 * Makes an element. `text`, when given, is the ONLY way payload data enters the
 * page — as a text node, never as markup.
 */
export function element(doc: PanelDocument, tag: string, className?: string, text?: string): PanelElement {
    const node = doc.createElement(tag);
    if (className !== undefined) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export function onClick(node: PanelElement, handler: () => void): void {
    node.addEventListener?.("click", handler);
}

/** A real button, so it is focusable and reachable from the keyboard. */
export function button(doc: PanelDocument, className: string, label: string, handler: () => void): PanelElement {
    const node = element(doc, "button", className, label);
    node.setAttribute("type", "button");
    onClick(node, handler);
    return node;
}

/**
 * A labelled text field.
 *
 * The value goes on as a property, never as an attribute, so nothing a person
 * typed — or a manifest carried — can end up inside the markup. `onInput` is
 * handed the field's current value on every keystroke, which is how the console
 * keeps a draft without reaching back into the document.
 */
export function field(
    doc: PanelDocument,
    id: string,
    label: string,
    value: string,
    onInput: (value: string) => void,
    options: { multiline?: boolean; placeholder?: string } = {},
): PanelElement {
    const wrap = element(doc, "div", "field");
    const caption = element(doc, "label", "field-label", label);
    caption.setAttribute("for", id);
    wrap.appendChild(caption);

    const input = element(doc, options.multiline === true ? "textarea" : "input", "field-input");
    input.setAttribute("id", id);
    if (options.multiline !== true) {
        input.setAttribute("type", "text");
    }
    if (options.placeholder !== undefined) {
        input.setAttribute("placeholder", options.placeholder);
    }
    input.value = value;
    input.addEventListener?.("input", () => onInput(input.value ?? ""));
    wrap.appendChild(input);
    return wrap;
}

/**
 * The CSS class for an asset type. Payload strings never reach a class name: a
 * type is used only if there is an accent for it, otherwise it falls back to the
 * neutral one.
 */
export function assetTypeClass(type: string): string {
    const known = Object.hasOwn(ASSET_ACCENTS, type) ? type : "unknown";
    return `chip type-${known}`;
}

/** An asset chip: a coloured square, then the words. */
export function assetChip(doc: PanelDocument, type: string, label: string): PanelElement {
    const chip = element(doc, "span", assetTypeClass(type));
    chip.appendChild(element(doc, "span", "dot"));
    chip.appendChild(element(doc, "span", undefined, label));
    return chip;
}

// ---------------------------------------------------------------------------
// Reading whatever the host hands us
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

/** First non-empty string among the candidates, or undefined. */
export function firstString(...candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate;
        }
    }
    return undefined;
}

/** A string field, or "" — the shape every screen wants for a label. */
export function stringOr(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

/** The `text` parts of an MCP tool result's content array, in order. */
export function textParts(content: unknown): string[] {
    if (!Array.isArray(content)) {
        return [];
    }
    return content
        .map(part => (isRecord(part) && part["type"] === "text" ? part["text"] : undefined))
        .filter((text): text is string => typeof text === "string");
}

/** The object this string spells out, if it spells out an object at all. */
export function asJsonObject(text: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        // Plain prose, not a payload. Fine — it becomes the message instead.
        return undefined;
    }
}

/** The first readable line of a tool result, for an error message. */
export function firstText(result: unknown): string | undefined {
    const parts = textParts(asRecord(result).content);
    return parts.length > 0 ? parts[0] : undefined;
}

/**
 * The structured payload of a tool result, whichever way it arrived.
 *
 * Hosts hand the panel a whole `CallToolResult`, but a test — or a screen
 * re-reading its own state — may pass the payload on its own. `kind` is the
 * discriminator every console screen keys off, so this returns the record
 * carrying one.
 */
export function payloadOf(value: unknown, kind: string): Record<string, unknown> | undefined {
    const outer = asRecord(value);
    const payload = asRecord(asRecord(asRecord(outer._meta)[PANEL_PAYLOAD_KEY]).payload);
    if (firstString(payload.kind) === kind) {
        return payload;
    }
    const structured = asRecord(outer.structuredContent);
    if (firstString(structured.kind) === kind) {
        return structured;
    }
    if (firstString(outer.kind) === kind) {
        return outer;
    }
    return undefined;
}

/** True when the host marked this result as a failure. */
export function isErrorResult(value: unknown): boolean {
    return asRecord(value).isError === true;
}
