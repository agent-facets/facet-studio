// A deliberately unhelpful DOM, for tests.
//
// It models exactly three things: elements, text nodes and fragments. There is
// no HTML parsing anywhere in it, and the properties a careless renderer would
// reach for throw on sight — so a regression cannot quietly pass. Nothing in the
// shipped panel imports this file; it exists so the console can be driven with
// real clicks and real redraws, in a test, with no browser.

import type { ConsolePorts, Outcome } from "./console.js";
import type { PanelDocument, PanelElement } from "./dom.js";

export class Node {}

export class Text extends Node {
    constructor(readonly data: string) {
        super();
    }
}

export class Element extends Node {
    className = "";
    children: Node[] = [];
    attrs = new Map<string, string>();
    handlers = new Map<string, (() => void)[]>();
    /** Set by the field helper; read back the way a real input is. */
    value = "";

    constructor(readonly tag: string) {
        super();
    }

    appendChild(child: Node): Node {
        this.children.push(child);
        return child;
    }

    setAttribute(name: string, value: string): void {
        this.attrs.set(name, value);
    }

    addEventListener(type: string, handler: () => void): void {
        const existing = this.handlers.get(type) ?? [];
        existing.push(handler);
        this.handlers.set(type, existing);
    }

    /** Fires every handler of a type, the way a real event would. */
    fire(type: string): void {
        for (const handler of this.handlers.get(type) ?? []) {
            handler();
        }
    }

    click(): void {
        this.fire("click");
    }

    /** Types into a field: sets the value, then fires input, as a person does. */
    type(value: string): void {
        this.value = value;
        this.fire("input");
    }

    get textContent(): string {
        return text(this);
    }

    set textContent(value: string | null) {
        this.children = value === null || value === "" ? [] : [new Text(value)];
    }
}

for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) {
    Object.defineProperty(Element.prototype, sink, {
        get(): never {
            throw new Error(`the view reached for ${sink}`);
        },
        set(): never {
            throw new Error(`the view reached for ${sink}`);
        },
    });
}

export class Fragment extends Node {
    children: Node[] = [];

    appendChild(child: Node): Node {
        this.children.push(child);
        return child;
    }
}

export function text(node: Node): string {
    if (node instanceof Text) {
        return node.data;
    }
    if (node instanceof Element || node instanceof Fragment) {
        return node.children.map(text).join("");
    }
    return "";
}

export function classes(node: Node): string[] {
    const found: string[] = [];
    const visit = (current: Node): void => {
        if (current instanceof Element) {
            if (current.className !== "") {
                found.push(current.className);
            }
            current.children.forEach(visit);
        } else if (current instanceof Fragment) {
            current.children.forEach(visit);
        }
    };
    visit(node);
    return found;
}

/** Every element in the tree matching a predicate, in document order. */
function collect(node: Node, matches: (element: Element) => boolean): Element[] {
    const found: Element[] = [];
    const visit = (current: Node): void => {
        if (current instanceof Element) {
            if (matches(current)) {
                found.push(current);
            }
            current.children.forEach(visit);
        } else if (current instanceof Fragment) {
            current.children.forEach(visit);
        }
    };
    visit(node);
    return found;
}

/** Every button whose rendered text equals `label`. */
export function buttonsLabelled(node: Node, label: string): Element[] {
    return collect(node, element => element.tag === "button" && text(element).trim() === label);
}

/** Every button whose rendered text starts with `prefix` — for "Update to 1.2.3". */
export function buttonsStarting(node: Node, prefix: string): Element[] {
    return collect(node, element => element.tag === "button" && text(element).trim().startsWith(prefix));
}

/** The input or textarea with this id. */
export function fieldWithId(node: Node, id: string): Element | undefined {
    return collect(node, element => element.attrs.get("id") === id)[0];
}

export const testDocument: PanelDocument = {
    createElement: tag => new Element(tag) as unknown as PanelElement,
    createTextNode: data => new Text(data),
    createDocumentFragment: () => new Fragment(),
};

/** A root to mount a console into. */
export function root(): Element {
    return new Element("main");
}

const nothing = async (): Promise<undefined> => undefined;
const fine = async (): Promise<Outcome> => ({ ok: true });

/**
 * Ports that do nothing successfully. Override the one method a test is about,
 * so the test reads as the behaviour it is checking and nothing else.
 */
export function stubPorts(overrides: Partial<ConsolePorts> = {}): ConsolePorts {
    return {
        browse: nothing,
        detail: nothing,
        readme: nothing,
        project: nothing,
        manifest: nothing,
        add: fine,
        remove: fine,
        install: fine,
        verify: fine,
        build: fine,
        modify: fine,
        ...overrides,
    };
}
