import { describe, expect, test } from "bun:test";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createServer, SERVER_NAME, SERVER_VERSION, type RegistrationDeps, type StudioServerDeps } from "./server.js";

/** A client with the MCP Apps UI extension turned on, as a UI-capable host sends it. */
const UI_CAPABLE: ClientCapabilities = { extensions: { [EXTENSION_ID]: {} } };

/** A plain client — no UI extension at all. This is the case that must not break. */
const TEXT_ONLY: ClientCapabilities = {};

interface Harness {
    client: Client;
    /** Resolves with what the registration seam was handed, once it fires. */
    seamDeps: Promise<RegistrationDeps>;
    close: () => Promise<void>;
}

/**
 * Runs a real client against a real server over the SDK's linked in-memory
 * transports, so every assertion below goes through an actual MCP handshake.
 */
async function connect(capabilities: ClientCapabilities, deps: StudioServerDeps = {}): Promise<Harness> {
    let announce!: (deps: RegistrationDeps) => void;
    const seamDeps = new Promise<RegistrationDeps>(resolve => {
        announce = resolve;
    });

    const server = createServer({
        ...deps,
        registerAll: (registerTarget, registrationDeps) => {
            deps.registerAll?.(registerTarget, registrationDeps);
            announce(registrationDeps);
        },
    });

    const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
        client,
        seamDeps,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

describe("createServer", () => {
    test("introduces itself as facet-studio 0.6.0", async () => {
        const harness = await connect(UI_CAPABLE);
        try {
            expect(harness.client.getServerVersion()).toMatchObject({
                name: SERVER_NAME,
                version: SERVER_VERSION,
            });
            expect(SERVER_NAME).toBe("facet-studio");
            expect(SERVER_VERSION).toBe("0.6.0");
        } finally {
            await harness.close();
        }
    });

    test("a client without the ui extension still initializes cleanly", async () => {
        const harness = await connect(TEXT_ONLY);
        try {
            expect(harness.client.getServerVersion()).toMatchObject({ name: SERVER_NAME });

            const deps = await harness.seamDeps;
            expect(deps.uiCapability).toBeUndefined();
            expect(deps.supportsUi).toBe(false);
            // The capabilities still reach the seam — just without the extension.
            expect(deps.clientCapabilities).toBeDefined();
            expect(deps.clientCapabilities?.extensions?.[EXTENSION_ID]).toBeUndefined();
        } finally {
            await harness.close();
        }
    });

    test("a ui-capable client reaches the seam with the extension resolved", async () => {
        const harness = await connect(UI_CAPABLE);
        try {
            const deps = await harness.seamDeps;
            expect(deps.supportsUi).toBe(true);
            expect(deps.uiCapability).toBeDefined();
            expect(deps.clientCapabilities?.extensions?.[EXTENSION_ID]).toBeDefined();
        } finally {
            await harness.close();
        }
    });

    test("passes the deps it was built with through to the seam", async () => {
        const marker: StudioServerDeps = {};
        const harness = await connect(UI_CAPABLE, marker);
        try {
            const deps = await harness.seamDeps;
            // Registration deps are the construction deps plus the negotiated
            // capabilities, so later items can read both from one argument.
            expect(deps).toHaveProperty("clientCapabilities");
            expect(deps).toHaveProperty("uiCapability");
            expect(deps).toHaveProperty("supportsUi");
        } finally {
            await harness.close();
        }
    });
});

describe("tools at the scaffold stage", () => {
    for (const [label, capabilities] of [
        ["ui-capable", UI_CAPABLE],
        ["text-only", TEXT_ONLY],
    ] as const) {
        test(`lists no tools for a ${label} client`, async () => {
            const harness = await connect(capabilities);
            try {
                // The tools capability has to be advertised during the handshake,
                // even though nothing is registered yet, or a host would never ask.
                expect(harness.client.getServerCapabilities()?.tools).toBeDefined();
                await expect(harness.client.listTools()).resolves.toMatchObject({ tools: [] });
            } finally {
                await harness.close();
            }
        });
    }
});

test("the brand token package resolves, ready for the panel work", async () => {
    const brand = await import("@agent-facets/brand");
    expect(brand.THEME).toBeDefined();
});
