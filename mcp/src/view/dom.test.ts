import { describe, it, expect } from "bun:test";
import { payloadOf, PANEL_PAYLOAD_KEY } from "./dom.js";

describe("payloadOf", () => {
    it("(a) payload in _meta[PANEL_PAYLOAD_KEY].payload with matching kind wins over structuredContent", () => {
        const metaPayload = { kind: "gallery", from: "meta" };
        const structuredPayload = { kind: "gallery", from: "structured" };
        const value = {
            _meta: {
                [PANEL_PAYLOAD_KEY]: {
                    payload: metaPayload,
                },
            },
            structuredContent: structuredPayload,
        };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual(metaPayload);
        expect(result?.from).toBe("meta");
    });

    it("(b) missing _meta falls back to structuredContent exactly as before", () => {
        const structuredPayload = { kind: "gallery" };
        const value = {
            structuredContent: structuredPayload,
        };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual(structuredPayload);
    });

    it("(c) bare record with kind still matches", () => {
        const value = { kind: "gallery", data: "test" };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual(value);
    });

    it("(d) adversarial: _meta present but payload is a string, falls through without throwing", () => {
        const value = {
            _meta: {
                [PANEL_PAYLOAD_KEY]: {
                    payload: "not a record",
                },
            },
            kind: "gallery",
        };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual(value);
    });

    it("(d) adversarial: _meta is null, falls through without throwing", () => {
        const value = {
            _meta: null,
            kind: "gallery",
        };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual(value);
    });

    it("(e) kind mismatch in _meta payload does not match, and does NOT shadow a matching structuredContent", () => {
        const metaPayload = { kind: "different" };
        const structuredPayload = { kind: "gallery", from: "structured" };
        const value = {
            _meta: {
                [PANEL_PAYLOAD_KEY]: {
                    payload: metaPayload,
                },
            },
            structuredContent: structuredPayload,
        };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual(structuredPayload);
        expect(result?.from).toBe("structured");
    });

    it("returns undefined when no matching payload is found", () => {
        const value = {
            kind: "other",
            structuredContent: { kind: "other" },
        };

        const result = payloadOf(value, "gallery");
        expect(result).toBeUndefined();
    });

    it("handles deeply missing _meta paths without throwing", () => {
        const value = {
            structuredContent: { kind: "gallery" },
        };

        const result = payloadOf(value, "gallery");
        expect(result).toEqual({ kind: "gallery" });
    });
});
