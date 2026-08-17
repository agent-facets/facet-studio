// Adversarial tests for registry sign-in.
//
// The mocked seam is narrow on purpose: only Cognito and the registry API are
// faked. The loopback listener is a real HTTP server driven by real requests,
// the credentials file is really written to a temp FACET_DIR, and the real
// `facet` CLI is really spawned against that file to prove it can read what we
// wrote. The developer's own ~/.facet is never read or touched — every test
// works inside a fresh mkdtemp directory and passes an explicit env object.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AuthFlowError,
    PANEL_RESOURCE_URI,
    type AuthPorts,
    browserCommand,
    constantTimeEquals,
    createPkce,
    readAuthConfig,
    readCredentialsFile,
    registerAuth,
    renderCredentialsIni,
    runBrowserLogin,
    scrubSecrets,
    startLoopback,
    writeCredentials,
} from "./auth.js";
import { createServer as createStudioServer } from "./server.js";

const UI_CAPABLE: ClientCapabilities = { extensions: { [EXTENSION_ID]: {} } };

/** A JWT-shaped string, so the redaction backstop has something real to catch. */
const FAKE_JWT = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "u-1" })).toString("base64url")}.c2lnbmF0dXJlLWJ5dGVz`;
const FAKE_PAT = "fct_pub_ABCDEFGHJKMN.PQRSTUVWXYZ23456789ABCDEFGHJKMNPQ";

const PROFILE = {
    user_uuid: "11111111-2222-3333-4444-555555555555",
    username: "brigade-tester",
    email: "brigade@example.test",
    tier: "free",
    suspended: false,
};

let sandbox: string;
let facetDir: string;

beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "facet-studio-auth-"));
    facetDir = join(sandbox, "home", ".facet");
});

afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

/** An environment with browser sign-in switched on, pointed at the sandbox. */
function oauthEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
        FACET_STUDIO_COGNITO_DOMAIN: "https://auth.example.test",
        FACET_STUDIO_OAUTH_CLIENT_ID: "client-abc",
        FACET_REGISTRY_URL: "https://api.example.test",
        FACET_DIR: facetDir,
        ...overrides,
    };
}

interface FetchCall {
    url: string;
    method: string;
    authorization: string | undefined;
    body: string | undefined;
}

interface MockFetch {
    calls: FetchCall[];
    fn: typeof globalThis.fetch;
}

/** A fetch that answers the two Cognito/registry routes and records everything. */
function mockFetch(handlers: Record<string, () => Response>): MockFetch {
    const calls: FetchCall[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const headers = new Headers(init?.headers ?? {});
        calls.push({
            url,
            method: init?.method ?? "GET",
            authorization: headers.get("authorization") ?? undefined,
            body: typeof init?.body === "string" ? init.body : undefined,
        });
        const path = new URL(url).pathname;
        const handler = handlers[path];
        if (handler === undefined) throw new Error(`unexpected request to ${url}`);
        return handler();
    }) as typeof globalThis.fetch;
    return { calls, fn };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The default happy-path registry: exchange a code, mint a PAT, report identity. */
function happyHandlers(): Record<string, () => Response> {
    return {
        "/oauth2/token": () => json({ access_token: FAKE_JWT, token_type: "Bearer", expires_in: 3600 }),
        "/v0/auth/tokens": () => json({ prefix: "ABCDEFGHJKMN", plaintext_token: FAKE_PAT, scopes: ["publish:*"], expires_at: "2027-01-01T00:00:00Z" }, 201),
        "/v0/auth/me": () => json(PROFILE),
    };
}

/**
 * Stands in for the browser: reads the authorize URL, then drives the redirect
 * back to the loopback listener with whatever state/code the test wants.
 */
function browserThatRedirects(options: { state?: "match" | "wrong"; code?: string | null; error?: string } = {}) {
    const seen: { authorizeUrl?: string; callbackStatus?: number; callbackBody?: string } = {};
    const openBrowser = async (url: string): Promise<void> => {
        seen.authorizeUrl = url;
        const authorize = new URL(url);
        const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        if (options.error !== undefined) {
            redirect.searchParams.set("error", options.error);
        } else {
            const state = authorize.searchParams.get("state") ?? "";
            redirect.searchParams.set("state", options.state === "wrong" ? `${state.slice(1)}X` : state);
            const code = options.code === undefined ? "auth-code-xyz" : options.code;
            if (code !== null) redirect.searchParams.set("code", code);
        }
        const response = await fetch(redirect.toString());
        seen.callbackStatus = response.status;
        seen.callbackBody = await response.text();
    };
    return { seen, openBrowser };
}

function ports(overrides: Partial<AuthPorts> = {}): AuthPorts {
    return {
        env: oauthEnv(),
        home: join(sandbox, "home"),
        fetch: mockFetch(happyHandlers()).fn,
        openBrowser: async () => undefined,
        randomBytes,
        callbackTimeoutMs: 5_000,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------

describe("configuration is a snapshot", () => {
    test("browser sign-in needs both OAuth settings", () => {
        const home = join(sandbox, "home");
        expect(readAuthConfig(oauthEnv(), home).browserFlowAvailable).toBe(true);
        expect(readAuthConfig(oauthEnv({ FACET_STUDIO_COGNITO_DOMAIN: undefined }), home).browserFlowAvailable).toBe(false);
        expect(readAuthConfig(oauthEnv({ FACET_STUDIO_OAUTH_CLIENT_ID: "  " }), home).browserFlowAvailable).toBe(false);
        expect(readAuthConfig({}, home).browserFlowAvailable).toBe(false);
    });

    test("the credentials path follows FACET_DIR and never the real home", () => {
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
        expect(config.credentialsPath).toBe(join(facetDir, "credentials"));
        expect(config.credentialsPath.startsWith(sandbox)).toBe(true);
        // Without FACET_DIR it is derived from the home we hand it, not os.homedir().
        expect(readAuthConfig({}, "/some/other/home").credentialsPath).toBe("/some/other/home/.facet/credentials");
    });

    test("the website URL is derived from the api host", () => {
        expect(readAuthConfig({ FACET_REGISTRY_URL: "https://api.agentfacets.io/" }, "/h").webUrl).toBe("https://agentfacets.io");
        expect(readAuthConfig({}, "/h").webUrl).toBe("https://agentfacets.io");
    });

    test("the snapshot survives the environment changing mid-flow", async () => {
        // Externally mutable state: something rewrites the environment while the
        // browser is open. The flow already holds its snapshot, so it must keep
        // talking to the domain and registry it started with.
        const env = oauthEnv();
        const browser = browserThatRedirects();
        const fetcher = mockFetch(happyHandlers());
        const openBrowser = async (url: string): Promise<void> => {
            env.FACET_STUDIO_COGNITO_DOMAIN = undefined;
            env.FACET_STUDIO_OAUTH_CLIENT_ID = undefined;
            env.FACET_REGISTRY_URL = "https://hijacked.example.test";
            await browser.openBrowser(url);
        };
        const config = readAuthConfig(env, join(sandbox, "home"));
        const result = await runBrowserLogin(config, ports({ fetch: fetcher.fn, openBrowser }));

        expect(result.username).toBe("brigade-tester");
        for (const call of fetcher.calls) {
            expect(call.url.startsWith("https://hijacked.example.test")).toBe(false);
        }
        expect(fetcher.calls.map(c => c.url)).toEqual([
            "https://auth.example.test/oauth2/token",
            "https://api.example.test/v0/auth/tokens",
            "https://api.example.test/v0/auth/me",
        ]);
    });
});

describe("PKCE material", () => {
    test("the verifier is long, base64url, and different every time", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 25; i += 1) {
            const pkce = createPkce();
            expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
            expect(pkce.verifier.length).toBeLessThanOrEqual(128);
            expect(pkce.verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
            expect(pkce.state.length).toBeGreaterThanOrEqual(32);
            seen.add(pkce.verifier);
            seen.add(pkce.state);
        }
        expect(seen.size).toBe(50);
    });

    test("the challenge is the S256 hash of the verifier", () => {
        const pkce = createPkce();
        const expected = createHash("sha256").update(pkce.verifier).digest("base64url");
        expect(pkce.challenge).toBe(expected);
        expect(pkce.challenge).not.toBe(pkce.verifier);
    });

    test("a verifier built from weak randomness still can't collide silently", () => {
        // Guards the wiring, not the entropy source: identical bytes in must
        // produce identical material out, so the generator really is reading
        // from the port it was given.
        const fixed = createPkce(size => new Uint8Array(size).fill(7));
        const again = createPkce(size => new Uint8Array(size).fill(7));
        expect(fixed.verifier).toBe(again.verifier);
        expect(fixed.verifier).not.toBe(createPkce().verifier);
    });

    test("state comparison is length-safe and constant-time in shape", () => {
        expect(constantTimeEquals("abc", "abc")).toBe(true);
        expect(constantTimeEquals("abc", "abd")).toBe(false);
        expect(constantTimeEquals("abc", "abcd")).toBe(false);
        expect(constantTimeEquals("", "")).toBe(true);
    });
});

describe("the loopback listener", () => {
    test("binds 127.0.0.1 on an ephemeral port", async () => {
        const session = await startLoopback("state-value", 5_000);
        try {
            expect(session.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
            expect(session.port).toBeGreaterThan(0);
        } finally {
            session.close();
        }
    });

    test("a mismatched state aborts the flow and closes the listener", async () => {
        const session = await startLoopback("the-real-state", 5_000);
        try {
            const response = await fetch(`${session.redirectUri}?state=not-the-real-state&code=abc`);
            expect(response.status).toBe(400);
            expect(await response.text()).toContain("could not be verified");
            await expect(session.code).rejects.toThrow(/state value that doesn't match/);

            // Single use: the listener is gone, so a replay can't try again.
            await expect(fetch(`${session.redirectUri}?state=the-real-state&code=abc`)).rejects.toThrow();
        } finally {
            session.close();
        }
    });

    test("a stray request does not burn the single use", async () => {
        const session = await startLoopback("s", 5_000);
        try {
            const stray = await fetch(`http://127.0.0.1:${session.port}/favicon.ico`);
            expect(stray.status).toBe(404);

            const good = await fetch(`${session.redirectUri}?state=s&code=the-code`);
            expect(good.status).toBe(200);
            expect(await session.code).toBe("the-code");
        } finally {
            session.close();
        }
    });

    test("gives up rather than listening forever", async () => {
        const session = await startLoopback("s", 40);
        try {
            await expect(session.code).rejects.toThrow(/gave up waiting/);
        } finally {
            session.close();
        }
    });

    test("a provider error comes back as an abort, not a hang", async () => {
        const session = await startLoopback("s", 5_000);
        try {
            const response = await fetch(`${session.redirectUri}?error=access_denied&error_description=user+said+no`);
            expect(response.status).toBe(400);
            await expect(session.code).rejects.toThrow(/user said no/);
        } finally {
            session.close();
        }
    });
});

describe("the browser sign-in", () => {
    test("sends a correct authorize request and saves the minted token", async () => {
        const browser = browserThatRedirects();
        const fetcher = mockFetch(happyHandlers());
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
        const result = await runBrowserLogin(config, ports({ fetch: fetcher.fn, openBrowser: browser.openBrowser }));

        const authorize = new URL(browser.seen.authorizeUrl ?? "");
        expect(authorize.origin + authorize.pathname).toBe("https://auth.example.test/oauth2/authorize");
        expect(authorize.searchParams.get("response_type")).toBe("code");
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.searchParams.get("client_id")).toBe("client-abc");
        expect(authorize.searchParams.get("scope")).toBe("email openid profile");
        expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        // The verifier itself must never leave this process.
        expect(authorize.searchParams.get("code_verifier")).toBeNull();
        expect(browser.seen.callbackStatus).toBe(200);

        const exchange = fetcher.calls[0];
        expect(exchange?.method).toBe("POST");
        const form = new URLSearchParams(exchange?.body ?? "");
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code_verifier")?.length ?? 0).toBeGreaterThanOrEqual(43);
        expect(form.get("code")).toBe("auth-code-xyz");

        // The PAT is minted with the JWT, because a PAT cannot mint a PAT.
        expect(fetcher.calls[1]?.authorization).toBe(`Bearer ${FAKE_JWT}`);
        expect(JSON.parse(fetcher.calls[1]?.body ?? "{}")).toMatchObject({ scopes: ["publish:*"] });
        // Identity is checked with the PAT, the credential we actually keep.
        expect(fetcher.calls[2]?.authorization).toBe(`Bearer ${FAKE_PAT}`);

        expect(result).toMatchObject({ username: "brigade-tester", email: "brigade@example.test", tier: "free" });
        expect(readCredentialsFile(config.credentialsPath)).toBe(FAKE_PAT);
    });

    test("writes the credentials file 0600, atomically, leaving no temp file behind", async () => {
        const browser = browserThatRedirects();
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
        await runBrowserLogin(config, ports({ fetch: mockFetch(happyHandlers()).fn, openBrowser: browser.openBrowser }));

        expect(statSync(config.credentialsPath).mode & 0o777).toBe(0o600);
        expect(Bun.file(config.credentialsPath).name).toBeDefined();
        const leftovers = [...new Bun.Glob(".credentials.*.tmp").scanSync({ cwd: facetDir, dot: true })];
        expect(leftovers).toEqual([]);
    });

    test("a mismatched state stops before anything is exchanged or written", async () => {
        const browser = browserThatRedirects({ state: "wrong" });
        const fetcher = mockFetch(happyHandlers());
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));

        await expect(runBrowserLogin(config, ports({ fetch: fetcher.fn, openBrowser: browser.openBrowser }))).rejects.toThrow(
            /state value that doesn't match/,
        );
        expect(fetcher.calls).toEqual([]);
        expect(existsSync(config.credentialsPath)).toBe(false);
    });

    test("a redirect without a code aborts", async () => {
        const browser = browserThatRedirects({ code: null });
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
        await expect(runBrowserLogin(config, ports({ openBrowser: browser.openBrowser }))).rejects.toThrow(/without an authorization code/);
    });

    test("a token in a shape we don't recognise is refused", async () => {
        const browser = browserThatRedirects();
        const handlers = happyHandlers();
        handlers["/v0/auth/tokens"] = () => json({ plaintext_token: "not-a-facet-token" }, 201);
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));

        await expect(runBrowserLogin(config, ports({ fetch: mockFetch(handlers).fn, openBrowser: browser.openBrowser }))).rejects.toThrow(
            /shape this server doesn't recognise/,
        );
        expect(existsSync(config.credentialsPath)).toBe(false);
    });
});

describe("secrets never reach the transcript", () => {
    test("scrubSecrets removes tokens it knows and tokens it doesn't", () => {
        expect(scrubSecrets(`saved ${FAKE_PAT} ok`)).toBe("saved [redacted] ok");
        expect(scrubSecrets(`bearer ${FAKE_JWT}`)).toBe("bearer [redacted]");
        expect(scrubSecrets("verifier=abcdefghijklmnop", ["abcdefghijklmnop"])).toBe("verifier=[redacted]");
        expect(scrubSecrets("nothing to see")).toBe("nothing to see");
    });

    test("a registry error that echoes the JWT is redacted before it is shown", async () => {
        const browser = browserThatRedirects();
        const handlers = happyHandlers();
        handlers["/v0/auth/tokens"] = () =>
            json({ code: "E_INTERACTIVE_SESSION_REQUIRED", error: `token ${FAKE_JWT} is not interactive` }, 403);
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));

        const error = await runBrowserLogin(config, ports({ fetch: mockFetch(handlers).fn, openBrowser: browser.openBrowser })).then(
            () => null,
            (e: unknown) => e as AuthFlowError,
        );
        expect(error).toBeInstanceOf(AuthFlowError);
        expect(error?.message).toContain("HTTP 403");
        expect(error?.message).not.toContain(FAKE_JWT);
        expect(error?.message).not.toContain("eyJ");
    });
});

describe("the tools", () => {
    interface Harness {
        client: Client;
        close: () => Promise<void>;
    }

    async function connect(overrides: Partial<AuthPorts> = {}): Promise<Harness> {
        const server = createStudioServer({
            registerAll: (target, deps) => registerAuth(target, { ...deps, ...ports(overrides) }),
        });
        const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: UI_CAPABLE });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return {
            client,
            close: async () => {
                await client.close();
                await server.close();
            },
        };
    }

    function textOf(result: CallToolResult): string {
        return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
    }

    test("both tools are listed with the panel and the right annotations", async () => {
        const harness = await connect();
        try {
            const { tools } = await harness.client.listTools();
            const byName = new Map(tools.map(tool => [tool.name, tool]));
            expect([...byName.keys()].sort()).toEqual(["facet_login", "facet_whoami"]);

            for (const tool of tools) {
                const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined;
                expect(meta?.ui?.resourceUri).toBe(PANEL_RESOURCE_URI);
            }
            expect(byName.get("facet_login")?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
            expect(byName.get("facet_whoami")?.annotations).toMatchObject({ readOnlyHint: true });
        } finally {
            await harness.close();
        }
    });

    test("facet_login without OAuth config returns the guided fallback, not a dead end", async () => {
        const harness = await connect({ env: { FACET_DIR: facetDir, FACET_REGISTRY_URL: "https://api.agentfacets.io" } });
        try {
            const result = (await harness.client.callTool({ name: "facet_login" })) as CallToolResult;
            const body = textOf(result);
            expect(result.isError).toBeFalsy();
            expect(body).toContain("https://agentfacets.io/auth/sign-in");
            expect(body).toContain("https://agentfacets.io/settings/tokens");
            expect(body).toContain("publish:*");
            expect(body).toContain("facet login");
            expect(body).toContain(join(facetDir, "credentials"));
            expect(body).toContain("facet studio");
            expect(result.structuredContent).toMatchObject({ signedIn: false, mode: "fallback" });
        } finally {
            await harness.close();
        }
    });

    test("facet_login reports the username and no credential material", async () => {
        const browser = browserThatRedirects();
        const harness = await connect({ fetch: mockFetch(happyHandlers()).fn, openBrowser: browser.openBrowser });
        try {
            const result = (await harness.client.callTool({ name: "facet_login" })) as CallToolResult;
            const body = textOf(result);
            const everything = body + JSON.stringify(result.structuredContent ?? {});

            expect(body).toContain("brigade-tester");
            expect(everything).not.toContain("fct_pub_");
            expect(everything).not.toContain(FAKE_PAT);
            expect(everything).not.toContain(FAKE_JWT);
            expect(everything).not.toContain("eyJ");
            expect(everything).not.toContain("auth-code-xyz");
        } finally {
            await harness.close();
        }
    });

    test("a failed browser sign-in falls back instead of dead-ending", async () => {
        const browser = browserThatRedirects({ error: "access_denied" });
        const harness = await connect({ openBrowser: browser.openBrowser });
        try {
            const result = (await harness.client.callTool({ name: "facet_login" })) as CallToolResult;
            const body = textOf(result);
            expect(result.isError).toBe(true);
            expect(body).toContain("access_denied");
            expect(body).toContain("/settings/tokens");
            expect(body).toContain("facet login");
        } finally {
            await harness.close();
        }
    });

    test("facet_whoami says who the saved credential belongs to, without showing it", async () => {
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
        writeCredentials(config.credentialsPath, FAKE_PAT);
        const fetcher = mockFetch(happyHandlers());
        const harness = await connect({ fetch: fetcher.fn });
        try {
            const result = (await harness.client.callTool({ name: "facet_whoami" })) as CallToolResult;
            const body = textOf(result);
            expect(body).toContain("brigade-tester <brigade@example.test>");
            expect(body).toContain("tier: free");
            expect(body).not.toContain("fct_pub_");
            expect(fetcher.calls[0]?.authorization).toBe(`Bearer ${FAKE_PAT}`);
        } finally {
            await harness.close();
        }
    });

    test("facet_whoami with no credential explains how to get one", async () => {
        const harness = await connect();
        try {
            const result = (await harness.client.callTool({ name: "facet_whoami" })) as CallToolResult;
            const body = textOf(result);
            expect(body).toContain("not signed in");
            expect(body).toContain("/settings/tokens");
            expect(result.structuredContent).toMatchObject({ signedIn: false });
        } finally {
            await harness.close();
        }
    });

    test("facet_whoami prefers FACET_TOKEN, exactly as the CLI does", async () => {
        const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
        writeCredentials(config.credentialsPath, FAKE_PAT);
        const fetcher = mockFetch(happyHandlers());
        const harness = await connect({ env: oauthEnv({ FACET_TOKEN: "fct_pub_ZZZZZZZZZZZZ.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY" }), fetch: fetcher.fn });
        try {
            const result = (await harness.client.callTool({ name: "facet_whoami" })) as CallToolResult;
            expect(fetcher.calls[0]?.authorization).toBe("Bearer fct_pub_ZZZZZZZZZZZZ.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY");
            expect(textOf(result)).toContain("FACET_TOKEN (environment)");
            expect(textOf(result)).not.toContain("ZZZZZZZZZZZZ");
        } finally {
            await harness.close();
        }
    });
});

describe("the credentials file", () => {
    test("is the INI shape the facet CLI parses", () => {
        expect(renderCredentialsIni(FAKE_PAT)).toBe(`[default]\ntoken=${FAKE_PAT}\n`);
        expect(readCredentialsFile("/nope/definitely/not/here")).toBeUndefined();
    });

    test("round-trips awkward values through the same escaping the CLI uses", () => {
        for (const value of ["plain-token", "with;semicolon", "with#hash", " padded ", 'has"quotes"']) {
            const path = join(sandbox, `cred-${Buffer.from(value).toString("hex")}`);
            writeCredentials(path, value);
            expect(readCredentialsFile(path)).toBe(value);
        }
    });

    test("is written 0600 even under a permissive umask", () => {
        const path = join(sandbox, "umask", "credentials");
        const previous = process.umask(0o000);
        try {
            writeCredentials(path, FAKE_PAT);
        } finally {
            process.umask(previous);
        }
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("the real facet CLI reads back what we wrote", async () => {
        // The proof that this file is CLI-compatible: a real `facet whoami`,
        // pointed at the temp FACET_DIR and a stub registry, with FACET_TOKEN
        // deliberately absent from its environment.
        const binary = Bun.which("facet");
        expect(binary, "the facet CLI must be on PATH for this test").not.toBeNull();

        let seenAuthorization: string | undefined;
        const registry = createServer((request, response) => {
            seenAuthorization = request.headers.authorization;
            if (new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/v0/auth/me") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(PROFILE));
                return;
            }
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: "E_NOT_FOUND" }));
        });
        await new Promise<void>(resolve => registry.listen({ host: "127.0.0.1", port: 0 }, resolve));
        const { port } = registry.address() as AddressInfo;

        try {
            const config = readAuthConfig(oauthEnv(), join(sandbox, "home"));
            writeCredentials(config.credentialsPath, FAKE_PAT);
            expect(config.credentialsPath.startsWith(sandbox)).toBe(true);

            const child = Bun.spawn([binary as string, "whoami"], {
                env: {
                    PATH: process.env.PATH ?? "",
                    HOME: join(sandbox, "home"),
                    FACET_DIR: facetDir,
                    FACET_REGISTRY_URL: `http://127.0.0.1:${port}`,
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);

            expect(`${stdout}${stderr}`).not.toContain("not signed in");
            expect(`${stdout}${stderr}`).not.toContain("couldn't read your registry credentials file");
            expect(stdout).toContain("brigade-tester <brigade@example.test>");
            expect(stdout).toContain("tier: free");
            expect(exitCode).toBe(0);
            expect(seenAuthorization).toBe(`Bearer ${FAKE_PAT}`);
        } finally {
            registry.close();
        }
    }, 30_000);
});

describe("opening a browser", () => {
    test("uses an argv array with no shell on every platform", () => {
        expect(browserCommand("darwin", "https://example.test/x")).toEqual(["open", "https://example.test/x"]);
        expect(browserCommand("linux", "https://example.test/x")).toEqual(["xdg-open", "https://example.test/x"]);
        expect(browserCommand("win32", "https://example.test/x")).toEqual([
            "rundll32",
            "url.dll,FileProtocolHandler",
            "https://example.test/x",
        ]);
        // The URL is always the last argument and is never concatenated into a
        // command string, so nothing inside it can become a shell token.
        for (const platform of ["darwin", "linux", "win32"]) {
            const argv = browserCommand(platform, "https://example.test/?a=b;rm -rf /");
            expect(argv.at(-1)).toBe("https://example.test/?a=b;rm -rf /");
            expect(argv.some(part => part.includes("&&") || part === "-c")).toBe(false);
        }
    });
});
