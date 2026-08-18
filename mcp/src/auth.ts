// Registry sign-in for the facet-studio MCP server.
//
// Two tools live here. `facet_login` gets the user a registry credential;
// `facet_whoami` says who that credential belongs to. Login has two shapes:
//
//   * Browser sign-in. When this server is configured with a Cognito Hosted UI
//     domain and an OAuth client id, we run the standard loopback PKCE dance —
//     open the browser, catch the redirect on 127.0.0.1, swap the code for a
//     JWT, mint a personal access token with it, and save that token.
//   * Guided fallback. Without that configuration we hand back short, concrete
//     instructions for minting a token on the website and pasting it into
//     `facet login`. Same destination, one more minute of typing.
//
// The registry does not yet have an OAuth app client that allows a loopback
// redirect, so in practice the fallback is the live path today. Both are real.
//
// One rule runs through the whole file: credential material never reaches the
// user, the transcript, or an error message. Not the JWT, not the PAT, not the
// PKCE verifier. Everything that could carry one goes through `scrubSecrets`.

import { BRAND, INK_DARK } from "@agent-facets/brand";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RegistrationDeps } from "./server.js";

/** The panel both tools render into, once mcp-panels ships it. */
export const PANEL_RESOURCE_URI = "ui://facet-studio/panel.html";

/** Where the registry API lives unless `FACET_REGISTRY_URL` says otherwise. */
export const DEFAULT_REGISTRY_URL = "https://api.agentfacets.io";

/** The website, used only for the sign-in and token links in the fallback. */
export const DEFAULT_WEB_URL = "https://agentfacets.io";

/** How long we wait on the loopback redirect before giving up. */
export const CALLBACK_TIMEOUT_MS = 120_000;

/**
 * How long any single HTTP call gets before we stop waiting.
 *
 * Both tools have to finish saying something. A registry that accepts the
 * connection and then goes quiet would otherwise leave the caller — and the
 * host's tool call — hanging with no way to tell whether anything happened.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** What the minted token is called, and what it is allowed to do. */
export const TOKEN_NAME = "facet-studio";
export const TOKEN_SCOPES = ["publish:*"];
export const TOKEN_EXPIRES_IN_DAYS = 90;

/** Shape of a personal access token: `fct_pub_<prefix>.<secret>`. */
const PAT_SHAPE = /^fct_pub_[A-Za-z0-9]+\.[A-Za-z0-9]+$/;

/** Everything the flow touches that isn't pure computation. Tests swap these. */
export interface AuthPorts {
    /** Environment to read configuration from. */
    env: Record<string, string | undefined>;
    /** Home directory, used when `FACET_DIR` isn't set. */
    home: string;
    /** HTTP client for the OAuth and registry calls. */
    fetch: typeof globalThis.fetch;
    /** Hands a URL to the user's browser. */
    openBrowser: (url: string) => Promise<void>;
    /** Source of cryptographic randomness. */
    randomBytes: (size: number) => Uint8Array;
    /** How long the loopback listener waits for the redirect. */
    callbackTimeoutMs: number;
    /** How long any one HTTP call gets before it is aborted. */
    requestTimeoutMs: number;
}

/** What `registerAuth` accepts: the server's own deps, plus optional overrides. */
export type AuthDeps = RegistrationDeps & Partial<AuthPorts>;

/** A snapshot of everything configuration-shaped, taken once per tool call. */
export interface AuthConfig {
    /** Cognito Hosted UI origin, e.g. `https://auth.example.com`. */
    readonly cognitoDomain: string | undefined;
    /** OAuth client id for the native/loopback app client. */
    readonly clientId: string | undefined;
    /** Registry API base URL, no trailing slash. */
    readonly registryUrl: string;
    /** Website base URL, used for the fallback's two links. */
    readonly webUrl: string;
    /** Absolute path to the CLI's credentials file. */
    readonly credentialsPath: string;
    /** A token supplied through `FACET_TOKEN`, if there is one. */
    readonly envToken: string | undefined;
    /** True when both OAuth settings are present, so browser sign-in can run. */
    readonly browserFlowAvailable: boolean;
}

/** Who the registry says we are. */
export interface Identity {
    username: string;
    email: string;
    tier: string;
    suspended: boolean;
}

/** A sign-in that didn't work, with a message already safe to show. */
export class AuthFlowError extends Error {
    override readonly name = "AuthFlowError";
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Takes one snapshot of the environment.
 *
 * Everything downstream reads this object rather than `process.env`, so a
 * variable that changes mid-flow can't move the goalposts: the fallback
 * decision and the flow that follows it see the same values.
 */
export function readAuthConfig(env: Record<string, string | undefined>, home: string): AuthConfig {
    const cognitoDomain = trimToUndefined(env.FACET_STUDIO_COGNITO_DOMAIN);
    const clientId = trimToUndefined(env.FACET_STUDIO_OAUTH_CLIENT_ID);
    const registryUrl = stripTrailingSlashes(trimToUndefined(env.FACET_REGISTRY_URL) ?? DEFAULT_REGISTRY_URL);
    const facetDir = trimToUndefined(env.FACET_DIR) ?? join(home, ".facet");

    return Object.freeze({
        cognitoDomain: cognitoDomain === undefined ? undefined : stripTrailingSlashes(cognitoDomain),
        clientId,
        registryUrl,
        webUrl: deriveWebUrl(registryUrl),
        credentialsPath: join(facetDir, "credentials"),
        envToken: trimToUndefined(env.FACET_TOKEN),
        browserFlowAvailable: cognitoDomain !== undefined && clientId !== undefined,
    });
}

/**
 * Guesses the website from the API URL. `api.agentfacets.io` is the website
 * with an `api.` glued on the front, so dropping it gets us there; anything
 * else (a local registry, say) is its own best guess.
 */
function deriveWebUrl(registryUrl: string): string {
    try {
        const url = new URL(registryUrl);
        if (url.hostname.startsWith("api.")) {
            url.hostname = url.hostname.slice("api.".length);
        }
        return stripTrailingSlashes(url.origin);
    } catch {
        return DEFAULT_WEB_URL;
    }
}

function trimToUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function stripTrailingSlashes(value: string): string {
    return value.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Keeping secrets out of everything we say
// ---------------------------------------------------------------------------

// Both patterns are deliberately wider than the real thing. A half-copied token
// is still a token: `fct_pub_` followed by anything token-shaped goes, whether
// or not the secret half made it into the string, and the same for a JWT that
// only kept its header. Redacting a little too much costs nobody anything.
const PAT_ANYWHERE = /fct_pub_[A-Za-z0-9]*(?:\.[A-Za-z0-9]*)?/g;
const JWT_ANYWHERE = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g;

/** Anything that has no business being in a line of text we show or send. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Removes credential material from text we're about to show someone.
 *
 * `known` holds the exact strings this run is carrying — the verifier, the
 * code, the JWT, the token. The two patterns are the backstop for anything we
 * didn't know about, such as a token echoed back inside a provider's error
 * body, or a hostile registry stuffing one into a field we print.
 */
export function scrubSecrets(text: string, known: readonly (string | undefined)[] = []): string {
    let out = text;
    for (const secret of known) {
        if (secret !== undefined && secret.length >= 8) {
            out = out.split(secret).join("[redacted]");
        }
    }
    return out.replace(PAT_ANYWHERE, "[redacted]").replace(JWT_ANYWHERE, "[redacted]");
}

/**
 * Makes a string the registry gave us safe to print.
 *
 * Everything crossing that boundary is somebody else's data, so it gets the
 * same treatment as an error body: strip the credential material first, flatten
 * control characters and newlines so nothing can forge extra lines in the
 * message, then cut it to a length that can't bury the rest of the output.
 *
 * Scrubbing has to happen before the truncation. The other way round, a cut
 * could land mid-token and leave a fragment the patterns no longer recognise.
 */
export function sanitizeUntrusted(value: unknown, limit: number): string {
    if (typeof value !== "string") return "";
    const scrubbed = scrubSecrets(value).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
    return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

/**
 * True when a credential can go into an `Authorization` header as-is.
 *
 * A token with a newline in it does not just fail — it fails *loudly*, with the
 * whole value inside the exception the header builder throws. Checking the
 * shape first means the value never reaches code that might repeat it back.
 * Visible ASCII only, which every real JWT and every real facet token is.
 */
export function isUsableBearerToken(value: string): boolean {
    return value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
}

/** Reads a response body for an error message: scrubbed, and kept short. */
async function describeBody(response: Response, known: readonly (string | undefined)[]): Promise<string> {
    let raw: string;
    try {
        raw = await response.text();
    } catch {
        return "(no readable body)";
    }
    const clean = scrubSecrets(raw, known).replace(/\s+/g, " ").trim();
    if (clean.length === 0) return "(empty body)";
    return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface Pkce {
    verifier: string;
    challenge: string;
    state: string;
}

/**
 * Fresh PKCE material. The verifier is 64 random bytes, which lands at 86
 * base64url characters — comfortably inside RFC 7636's 43-to-128 range and
 * well past the 43-character floor. `state` is its own 32 random bytes so a
 * redirect can be tied back to the request that started it.
 */
export function createPkce(random: (size: number) => Uint8Array = randomBytes): Pkce {
    const verifier = base64url(random(64));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge, state: base64url(random(32)) };
}

function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compares two strings without letting the timing say how far it got.
 *
 * Both sides are hashed first and the 32-byte digests are what get compared.
 * That is the point: comparing the strings directly needs a length check up
 * front, and that check answers "how long is the secret?" before a single byte
 * is looked at. Digests are always the same size, so there is nothing to
 * short-circuit on — every call does the identical amount of work.
 */
export function constantTimeEquals(a: string, b: string): boolean {
    const left = createHash("sha256").update(a, "utf8").digest();
    const right = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(left, right);
}

/** The authorize URL the browser gets sent to. */
export function buildAuthorizeUrl(config: AuthConfig, pkce: Pkce, redirectUri: string): string {
    if (config.cognitoDomain === undefined || config.clientId === undefined) {
        throw new AuthFlowError("browser sign-in is not configured for this server");
    }
    const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "email openid profile");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("state", pkce.state);
    return url.toString();
}

// ---------------------------------------------------------------------------
// The loopback listener
// ---------------------------------------------------------------------------

export interface LoopbackSession {
    /** The redirect URI to register with the provider — always 127.0.0.1. */
    readonly redirectUri: string;
    /** The port we actually got. */
    readonly port: number;
    /** Resolves with the authorization code, or rejects if the flow aborts. */
    readonly code: Promise<string>;
    /** Tears the listener down. Safe to call more than once. */
    close: () => void;
}

/**
 * Listens on an ephemeral loopback port for exactly one redirect.
 *
 * Three things make this safe to point a browser at. It binds 127.0.0.1 alone,
 * so nothing off this machine can reach it. It answers exactly one *verified*
 * `/callback` — the second one gets a 409, so a replayed redirect can't start a
 * second exchange. And it gives up after the timeout rather than sitting open
 * forever.
 *
 * The `state` check is the gate for all of that. A redirect that can't produce
 * the state we generated is answered politely and then dropped: it doesn't
 * consume the single use, and it doesn't end the sign-in. Only a caller that
 * already knows the state can affect this session at all.
 */
export async function startLoopback(expectedState: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<LoopbackSession> {
    const server = createHttpServer();
    const sockets = new Set<Socket>();
    server.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address === "string") {
        server.close();
        throw new AuthFlowError("could not open a local port to receive the sign-in redirect");
    }
    const port = address.port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    let settle!: (code: string) => void;
    let abort!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
        settle = resolve;
        abort = reject;
    });
    // Nothing else is awaiting this promise until the caller does, and the
    // caller may bail out first; swallowing here keeps that from surfacing as
    // an unhandled rejection.
    code.catch(() => undefined);

    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        server.close();
        // End rather than destroy, so a reply that is still on its way out
        // reaches the browser intact. Anything still hanging around a moment
        // later gets cut off.
        for (const socket of sockets) socket.end();
        const sweep = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
        }, 250);
        sweep.unref?.();
    };

    const timer = setTimeout(() => {
        abort(new AuthFlowError(`gave up waiting for the browser to come back after ${Math.round(timeoutMs / 1000)}s`));
        close();
    }, timeoutMs);
    timer.unref?.();

    let used = false;
    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
        const target = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

        if (target.pathname !== "/callback") {
            reply(response, 404, page("Nothing here", "This page isn't part of the sign-in flow."));
            return;
        }

        // State comes first, before anything else is even looked at, and a
        // redirect that fails it is answered and then forgotten — the session
        // is not marked used and the sign-in is not aborted.
        //
        // Anything on this machine can reach a loopback port, and so can any web
        // page the user happens to have open. If an unverified callback could
        // end the flow, a single unauthenticated GET would cancel a sign-in the
        // user is in the middle of. Only a redirect that proves it knows the
        // state we generated gets to decide anything, and that includes the
        // ones carrying `error=` — an error is a claim about our flow, and an
        // unverified claim is just noise.
        const state = target.searchParams.get("state");
        if (state === null || !constantTimeEquals(state, expectedState)) {
            reply(
                response,
                400,
                page("Sign-in could not be verified", "The redirect didn't match the request that started it, so it was ignored and nothing was saved."),
            );
            return;
        }

        if (used) {
            reply(response, 409, page("Already handled", "This sign-in link has already been used. Start over if you need to."));
            return;
        }
        used = true;

        const providerError = target.searchParams.get("error");
        if (providerError !== null) {
            const detail = target.searchParams.get("error_description") ?? providerError;
            reply(response, 400, page("Sign-in didn't finish", "You can close this tab and try again."), () => {
                abort(new AuthFlowError(`the sign-in provider reported: ${sanitizeUntrusted(detail, 200)}`));
                close();
            });
            return;
        }

        const authorizationCode = target.searchParams.get("code");
        if (authorizationCode === null || authorizationCode.length === 0) {
            reply(response, 400, page("Sign-in didn't finish", "The redirect arrived without an authorization code."), () => {
                abort(new AuthFlowError("sign-in aborted: the redirect arrived without an authorization code"));
                close();
            });
            return;
        }

        reply(response, 200, page("You're signed in", "facet studio has what it needs. You can close this tab."), () => {
            settle(authorizationCode);
            close();
        });
    });

    return { redirectUri, port, code, close };
}

function reply(response: ServerResponse, status: number, html: string, afterFlush?: () => void): void {
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(html, () => afterFlush?.());
}

/** The little branded page the browser lands on when it comes back. */
function page(title: string, detail: string): string {
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        `<title>${escapeHtml(title)} · facet studio</title>`,
        `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${INK_DARK.bg};` +
            `color:${INK_DARK.ink};font:16px/1.5 ui-sans-serif,system-ui,sans-serif}` +
            `main{max-width:34rem;padding:2.5rem;text-align:center}` +
            `h1{margin:0 0 .5rem;font-size:1.4rem;color:${BRAND.purple}}` +
            `p{margin:0;color:${INK_DARK.inkDim}}` +
            `small{display:block;margin-top:2rem;color:${INK_DARK.inkFaint};letter-spacing:.08em;text-transform:uppercase}</style>`,
        "</head><body><main>",
        `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`,
        "<small>facet studio</small>",
        "</main></body></html>",
    ].join("");
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Talking to Cognito and the registry
// ---------------------------------------------------------------------------

/**
 * One HTTP call, with a deadline on it.
 *
 * Every request in this file goes through here, because a tool call that never
 * comes back is its own kind of failure: the host waits, the user waits, and
 * nobody can tell whether a token was minted. `what` names the far end so the
 * timeout message says which hop stalled, and it is our own string — the URL
 * never appears, since it carries nothing the caller needs and we don't want to
 * be in the business of proving that.
 */
async function fetchWithDeadline(ports: AuthPorts, url: string, init: RequestInit, what: string): Promise<Response> {
    const timeout = AbortSignal.timeout(ports.requestTimeoutMs);
    try {
        return await ports.fetch(url, { ...init, signal: timeout });
    } catch (error) {
        if (timeout.aborted || isAbortError(error)) {
            throw new AuthFlowError(`${what} did not answer within ${Math.round(ports.requestTimeoutMs / 1000)}s, so the sign-in was stopped`);
        }
        throw error;
    }
}

/** Whether a thrown thing is "the request was cancelled" rather than a real failure. */
function isAbortError(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === "AbortError" || name === "TimeoutError";
}

/** Swaps the authorization code for a Cognito access token. */
async function exchangeCode(
    config: AuthConfig,
    pkce: Pkce,
    authorizationCode: string,
    redirectUri: string,
    ports: AuthPorts,
): Promise<string> {
    if (config.cognitoDomain === undefined || config.clientId === undefined) {
        throw new AuthFlowError("browser sign-in is not configured for this server");
    }
    const secrets = [pkce.verifier, authorizationCode];
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: authorizationCode,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
    });

    const response = await fetchWithDeadline(
        ports,
        `${config.cognitoDomain}/oauth2/token`,
        {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: body.toString(),
        },
        "the sign-in provider",
    );
    if (!response.ok) {
        throw new AuthFlowError(
            `the sign-in provider refused the code exchange (HTTP ${response.status}): ${await describeBody(response, secrets)}`,
        );
    }

    const payload = (await response.json()) as { access_token?: unknown };
    if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
        throw new AuthFlowError("the sign-in provider returned no access token");
    }
    // Checked here, at the doorway, rather than where it gets used. A token
    // carrying a newline blows up the header builder *with the token in the
    // exception*, so the value has to be refused before it can be quoted back
    // by code that has no idea it is holding a secret. The message below says
    // nothing about what was wrong beyond the shape, on purpose.
    if (!isUsableBearerToken(payload.access_token)) {
        throw new AuthFlowError("the sign-in provider returned an access token this server will not use: it is not a well-formed bearer token");
    }
    return payload.access_token;
}

/**
 * Mints a personal access token using the interactive session.
 *
 * The registry deliberately refuses to let a PAT mint another PAT, so this
 * call only works while we're holding the JWT — which is also why the JWT
 * never gets written anywhere. It exists for this one request.
 */
async function mintPat(config: AuthConfig, jwt: string, ports: AuthPorts): Promise<string> {
    if (!isUsableBearerToken(jwt)) {
        throw new AuthFlowError("refusing to send a malformed access token to the registry");
    }
    const response = await fetchWithDeadline(
        ports,
        `${config.registryUrl}/v0/auth/tokens`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${jwt}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({ name: TOKEN_NAME, scopes: TOKEN_SCOPES, expires_in_days: TOKEN_EXPIRES_IN_DAYS }),
        },
        "the registry",
    );
    if (!response.ok) {
        throw new AuthFlowError(
            `the registry refused to mint a token (HTTP ${response.status}): ${await describeBody(response, [jwt])}`,
        );
    }

    const payload = (await response.json()) as { plaintext_token?: unknown };
    const token = payload.plaintext_token;
    if (typeof token !== "string" || !PAT_SHAPE.test(token)) {
        throw new AuthFlowError("the registry returned a token in a shape this server doesn't recognise");
    }
    return token;
}

/** How much of each profile field we are willing to repeat back. */
const USERNAME_LIMIT = 64;
const EMAIL_LIMIT = 128;
const TIER_LIMIT = 32;

/** Shown instead of a username that was empty, or was entirely secret. */
const UNNAMED_ACCOUNT = "(unnamed account)";

/**
 * Asks the registry who a credential belongs to.
 *
 * The answer is the one thing in this flow we print verbatim, which makes it
 * the one thing worth being paranoid about. A registry that has been taken over
 * — or is just having a bad day — can put anything in these fields, including a
 * token it wants echoed into the transcript, or a screenful of newlines that
 * pushes the rest of the message out of view. So none of it is trusted: every
 * field is scrubbed, flattened onto one line, and cut to a sane length before
 * it becomes part of an {@link Identity}. Everything downstream can then treat
 * an Identity as safe to print, because it is.
 */
export async function fetchIdentity(config: AuthConfig, token: string, ports: AuthPorts): Promise<Identity> {
    if (!isUsableBearerToken(token)) {
        throw new AuthFlowError("the stored credential is not a well-formed token, so it was not sent anywhere");
    }
    const response = await fetchWithDeadline(
        ports,
        `${config.registryUrl}/v0/auth/me`,
        { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
        "the registry",
    );
    if (!response.ok) {
        throw new AuthFlowError(
            `the registry did not recognise the credential (HTTP ${response.status}): ${await describeBody(response, [token])}`,
        );
    }
    const payload = (await response.json()) as Partial<Record<keyof Identity | "user_uuid", unknown>>;
    if (typeof payload.username !== "string") {
        throw new AuthFlowError("the registry returned a profile without a username");
    }
    const username = sanitizeUntrusted(payload.username, USERNAME_LIMIT);
    return {
        username: username.length > 0 ? username : UNNAMED_ACCOUNT,
        email: sanitizeUntrusted(payload.email, EMAIL_LIMIT),
        tier: sanitizeUntrusted(payload.tier, TIER_LIMIT) || "unknown",
        suspended: payload.suspended === true,
    };
}

// ---------------------------------------------------------------------------
// The credentials file
// ---------------------------------------------------------------------------

/**
 * Serialises the credential the way the facet CLI reads it back: an INI file
 * with a single `default` profile holding a `token` key. The escaping mirrors
 * the `ini` package's, so a token with an awkward character round-trips.
 */
export function renderCredentialsIni(token: string): string {
    return `[default]\ntoken=${iniSafe(token)}\n`;
}

function iniSafe(value: string): string {
    const quoted = value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (/[=\r\n]/.test(value) || value.startsWith("[") || value !== value.trim() || quoted) {
        return JSON.stringify(value);
    }
    return value.replace(/;/g, "\\;").replace(/#/g, "\\#");
}

/**
 * Saves the token where the CLI looks for it, readable by nobody else.
 *
 * We write a temp file in the same directory, tighten it to exactly 0600 with
 * an explicit chmod (the `mode` option is subject to umask, a chmod isn't),
 * then rename it into place. Rename is atomic on the same filesystem and
 * carries the mode with it, so the token is never on disk — not even for an
 * instant, not even under a temp name — with permissions anyone else can read.
 * That is also why there is no chmod after the rename: it would paper over a
 * loose temp file rather than prevent one.
 */
export function writeCredentials(path: string, token: string, random: (size: number) => Uint8Array = randomBytes): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.credentials.${base64url(random(9)).replace(/[^A-Za-z0-9]/g, "")}.tmp`);
    try {
        writeFileSync(temporary, renderCredentialsIni(token), { encoding: "utf8", mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}

/** Where a credential came from, mirroring how the CLI resolves one. */
export type CredentialSource = { kind: "env"; token: string } | { kind: "file"; token: string } | { kind: "absent" };

/**
 * Finds the credential the CLI would use: `FACET_TOKEN` wins, then the file.
 * Matching that order matters — otherwise this tool would report on a
 * credential that every actual `facet` command ignores.
 */
export function resolveCredential(config: AuthConfig): CredentialSource {
    if (config.envToken !== undefined) {
        return { kind: "env", token: config.envToken };
    }
    const fromFile = readCredentialsFile(config.credentialsPath);
    return fromFile === undefined ? { kind: "absent" } : { kind: "file", token: fromFile };
}

/** Pulls `token` out of the `[default]` profile, or nothing if it isn't there. */
export function readCredentialsFile(path: string): string | undefined {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    let section: string | undefined;
    for (const line of contents.split(/[\r\n]+/g)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
        const header = /^\[([^\]]*)\]$/.exec(trimmed);
        if (header !== null) {
            section = header[1];
            continue;
        }
        if (section !== "default") continue;
        const separator = trimmed.indexOf("=");
        if (separator < 0) continue;
        if (trimmed.slice(0, separator).trim() !== "token") continue;
        const value = iniUnsafe(trimmed.slice(separator + 1).trim());
        if (value.length > 0) return value;
    }
    return undefined;
}

function iniUnsafe(value: string): string {
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value) as string;
        } catch {
            return value;
        }
    }
    return value.replace(/\\([;#])/g, "$1");
}

// ---------------------------------------------------------------------------
// Opening a browser
// ---------------------------------------------------------------------------

/** The argv for handing a URL to the desktop's default browser. */
export function browserCommand(platform: string, url: string): string[] {
    if (platform === "darwin") return ["open", url];
    if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
    return ["xdg-open", url];
}

/**
 * Launches the browser through an argv array — no shell anywhere in the path,
 * so nothing in the URL can turn into a command. We also refuse anything that
 * isn't plain http(s) before it reaches the spawn.
 */
export function openBrowser(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return Promise.reject(new AuthFlowError(`refusing to open a ${parsed.protocol} URL`));
    }
    const [command, ...args] = browserCommand(process.platform, url);
    if (command === undefined) {
        return Promise.reject(new AuthFlowError("no browser command for this platform"));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

// ---------------------------------------------------------------------------
// The browser sign-in, start to finish
// ---------------------------------------------------------------------------

export interface LoginSuccess extends Identity {
    credentialsPath: string;
}

/**
 * Runs the whole loopback PKCE sign-in against the snapshot it's given.
 *
 * The new token is proved before it is saved, never the other way round. The
 * credentials file may already hold a token the user is happily publishing
 * with, and overwriting it with something unverified turns "your sign-in
 * didn't work" into "you are now signed out of the account you had". So the
 * order is mint, check with `/auth/me`, and only then write. If the check
 * fails, the freshly minted token is simply dropped — it still exists on the
 * account and can be revoked there, which is a far cheaper problem than a
 * clobbered credential.
 *
 * Every local that could be carrying credential material is declared out here
 * so the catch can hand all of them to the scrubber. An error thrown from deep
 * inside `fetch` knows nothing about secrets and will happily quote one.
 */
export async function runBrowserLogin(config: AuthConfig, ports: AuthPorts): Promise<LoginSuccess> {
    const pkce = createPkce(ports.randomBytes);
    const session = await startLoopback(pkce.state, ports.callbackTimeoutMs);
    let authorizationCode: string | undefined;
    let jwt: string | undefined;
    let token: string | undefined;
    try {
        await ports.openBrowser(buildAuthorizeUrl(config, pkce, session.redirectUri));
        authorizationCode = await session.code;
        jwt = await exchangeCode(config, pkce, authorizationCode, session.redirectUri, ports);
        token = await mintPat(config, jwt, ports);
        const identity = await verifyBeforeSaving(config, token, ports);
        writeCredentials(config.credentialsPath, token, ports.randomBytes);
        return { ...identity, credentialsPath: config.credentialsPath };
    } catch (error) {
        throw new AuthFlowError(scrubSecrets(messageOf(error), [pkce.verifier, pkce.state, authorizationCode, jwt, token]));
    } finally {
        session.close();
    }
}

/**
 * Checks a brand-new token with the registry, and says plainly what didn't
 * happen if the check fails.
 *
 * The extra sentence on the error matters more than it looks: the user is about
 * to be told their sign-in failed, and the next thing they'll wonder is whether
 * the credential they already had is still there. It is.
 */
async function verifyBeforeSaving(config: AuthConfig, token: string, ports: AuthPorts): Promise<Identity> {
    try {
        return await fetchIdentity(config, token, ports);
    } catch (error) {
        throw new AuthFlowError(
            `the new token could not be verified (${messageOf(error)}); it was not saved, so any credential already at ${config.credentialsPath} is untouched`,
        );
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// What the tools say
// ---------------------------------------------------------------------------

/** The success line. Deliberately carries the username and nothing secret. */
export function signedInMessage(success: LoginSuccess): string {
    const who = success.email.length > 0 ? `${success.username} <${success.email}>` : success.username;
    return [
        `facet studio · signed in as ${who}`,
        "",
        `  tier: ${success.tier}${success.suspended ? " (account suspended)" : ""}`,
        `  credential: saved to ${success.credentialsPath}, readable only by you (0600)`,
        "",
        "The token itself is never shown here or written to any log. `facet whoami`",
        "in a terminal reads the same file back if you want to confirm it.",
    ].join("\n");
}

/**
 * The guided path: what to do when this server can't drive the browser.
 *
 * This is the live path today, not a consolation prize, so it names the exact
 * pages, the scope to pick, and the command that stores the result.
 */
export function fallbackMessage(config: AuthConfig, reason?: string): string {
    const lines = [
        "facet studio · registry sign-in",
        "",
    ];
    if (reason !== undefined) {
        lines.push(`Browser sign-in didn't work: ${reason}`, "", "You can still sign in by hand — it takes about a minute:");
    } else {
        lines.push("This server isn't set up to drive browser sign-in, so use the registry's", "token flow instead — it takes about a minute:");
    }
    lines.push(
        "",
        `  1. Open ${config.webUrl}/auth/sign-in and continue with email or Google.`,
        `  2. Go to ${config.webUrl}/settings/tokens and mint a token. The default`,
        "     scope, publish:*, is the right one.",
        "  3. Run `facet login` in a terminal and paste the token when it asks.",
        "",
        `That writes the token to ${config.credentialsPath} with 0600 permissions —`,
        "exactly the file this server would have written. Run facet_whoami afterwards",
        "and it will read it back.",
        "",
        "The token is a secret: paste it into `facet login`, not into this chat.",
    );
    if (reason === undefined) {
        lines.push(
            "",
            "(One-click browser sign-in switches on once FACET_STUDIO_COGNITO_DOMAIN and",
            "FACET_STUDIO_OAUTH_CLIENT_ID are set and the registry has a matching OAuth",
            "client. Neither exists yet.)",
        );
    }
    return lines.join("\n");
}

/** What `facet_whoami` says when there's no credential anywhere. */
export function notSignedInMessage(config: AuthConfig): string {
    return ["facet studio · not signed in", "", "No registry credential found.", "", fallbackMessage(config)].join("\n");
}

// ---------------------------------------------------------------------------
// The card the panel draws
// ---------------------------------------------------------------------------

/**
 * The five fields the result panel reads, spelled exactly as the lifecycle tools
 * in tools.ts spell them.
 *
 * Sign-in results ride the same view as everything else, so they have to fill in
 * the same shape. Leave the fields out and the panel has nothing to go on: the
 * card comes up titled "Unknown facet" with "Result" above it, which is both
 * ugly and untrue. The names are written out here rather than imported from the
 * view, so the server never drags the browser half of the panel into its module
 * graph — the same reason tools.ts writes them out too.
 */
export interface AuthPanelCard {
    facet: string;
    operation: string;
    status: "success" | "error";
    message: string;
    /** Always empty. Signing in makes no assets, and an invented row would be a lie. */
    assets: never[];
}

/** What the card calls each tool, in the lifecycle tools' phrasing. */
export const LOGIN_OPERATION = "Sign in to the registry";
export const WHOAMI_OPERATION = "Registry identity";

/** Shown when the registry URL is so mangled there is no host to pull out of it. */
const UNNAMED_REGISTRY = "facet registry";

/**
 * The JWT shape again, this time blind to case. See {@link registryLabel} for
 * why one field needs its own copy of a pattern the backstop already has.
 */
const JWT_ANY_CASE = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/gi;

/**
 * The registry's host, for the times there is no account to name.
 *
 * Two things about this value. It is environment data rather than registry data,
 * so unlike an {@link Identity} it has never been near `sanitizeUntrusted` —
 * that is fine on its own, because every card field leaves through `text()` and
 * gets scrubbed there.
 *
 * The catch is that `new URL` lowercases a host on the way out, and the JWT
 * backstop is deliberately case-sensitive: `eyJ` is what a JWT header base64s
 * to, and `eyj` is not a JWT. So a token-shaped hostname would come out of the
 * parser already case-folded, and sail past a scrubber that would have caught
 * the string the environment actually set. Hence the case-blind pass right here,
 * on the one value that goes through URL normalisation before it is printed. The
 * token pattern needs no such help — `fct_pub_` is lowercase already and the
 * rest of it never cared about case.
 */
export function registryLabel(registryUrl: string): string {
    try {
        const { host } = new URL(registryUrl);
        if (host.length > 0) {
            return host.replace(JWT_ANY_CASE, "[redacted]");
        }
    } catch {
        // Not a URL we can parse. Whatever the environment set is still the
        // truest thing we can say about where this call was pointed.
    }
    const raw = registryUrl.trim();
    return raw.length > 0 ? raw : UNNAMED_REGISTRY;
}

/**
 * Who the card is about: the account when we know it, the registry otherwise.
 *
 * Never blank, and that is the whole job — the panel reads an empty title as a
 * missing one and falls straight back to "Unknown facet".
 */
function cardSubject(config: AuthConfig, username?: string): string {
    const named = username?.trim() ?? "";
    return named.length > 0 ? named : registryLabel(config.registryUrl);
}

/**
 * The card fields for one finished call. `message` is the same prose the text
 * content carries, so the two halves of a reply always say the same thing.
 */
function card(operation: string, subject: string, status: "success" | "error", message: string): AuthPanelCard {
    return { facet: subject, operation, status, message, assets: [] };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function resolvePorts(deps: AuthDeps): AuthPorts {
    const env = deps.env ?? process.env;
    return {
        env,
        home: deps.home ?? env.HOME ?? homedir(),
        fetch: deps.fetch ?? globalThis.fetch,
        openBrowser: deps.openBrowser ?? openBrowser,
        randomBytes: deps.randomBytes ?? randomBytes,
        callbackTimeoutMs: deps.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS,
        requestTimeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    };
}

/**
 * The single door everything these tools say goes out through — and the last
 * place a secret can be caught.
 *
 * Both halves get scrubbed, the prose and the structured fields, because a host
 * may show either one. The fields are already built from sanitised values, so
 * in ordinary operation this changes nothing; it exists for the day somebody
 * adds a field and forgets. One chokepoint is easier to keep honest than a
 * rule everyone has to remember.
 */
function text(body: string, structured: Record<string, unknown>, isError = false) {
    return {
        content: [{ type: "text" as const, text: scrubSecrets(body) }],
        structuredContent: scrubStructured(structured),
        ...(isError ? { isError: true } : {}),
    };
}

/** How deep the structured walk will go, and how many values it will look at. */
export const SCRUB_MAX_DEPTH = 8;
export const SCRUB_MAX_NODES = 5_000;

/** What a value past those limits turns into, rather than being passed through. */
export const SCRUB_OMITTED = "[omitted]";

/**
 * Scrubs every string anywhere in a structured payload, not just the top row.
 *
 * A host may render `structuredContent` as readily as the prose, so a secret is
 * just as exposed sitting three objects down or inside an array as it is at the
 * top level. This walks the whole thing — objects, arrays, and the keys as well
 * as the values, since a key is a string somebody will see too.
 *
 * The walk is bounded twice, by depth and by how many values it visits, so a
 * payload built to be expensive to inspect can't turn one tool reply into a
 * long computation. Anything past a limit is replaced rather than copied
 * through: hitting the limit means we stopped being able to check, and passing
 * an unchecked value along is the one outcome worth avoiding. The same goes for
 * a cycle — an object that contains itself is replaced where it repeats.
 *
 * Real payloads here are a handful of flat fields, so the limits never come
 * near them. They exist for whatever arrives on a bad day.
 */
export function scrubStructured(structured: Record<string, unknown>): Record<string, unknown> {
    const budget = { nodes: SCRUB_MAX_NODES };
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(structured)) {
        out[scrubSecrets(key)] = scrubValue(value, SCRUB_MAX_DEPTH, budget, new Set());
    }
    return out;
}

function scrubValue(value: unknown, depth: number, budget: { nodes: number }, onPath: Set<object>): unknown {
    if (depth < 0 || budget.nodes <= 0) return SCRUB_OMITTED;
    budget.nodes -= 1;

    if (typeof value === "string") return scrubSecrets(value);
    if (value === null || typeof value !== "object") return value;
    if (onPath.has(value)) return SCRUB_OMITTED;

    onPath.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map(item => scrubValue(item, depth - 1, budget, onPath));
        }
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[scrubSecrets(key)] = scrubValue(item, depth - 1, budget, onPath);
        }
        return out;
    } finally {
        onPath.delete(value);
    }
}

/** The parts of a tool registration that don't depend on the host. */
interface AuthToolConfig {
    title: string;
    description: string;
    annotations: ToolAnnotations;
}

/**
 * Wires `facet_login` and `facet_whoami` into the server.
 *
 * A host that negotiated the UI extension gets App tools carrying the panel's
 * resource URI; a host that didn't gets the same tools with no UI metadata at
 * all. That has to match, because the panel resource is only published for
 * UI-capable hosts — pointing a text-only host at `ui://facet-studio/panel.html`
 * would be advertising a view that was never registered, and the first thing it
 * did with that pointer would be to ask for a resource that isn't there. The
 * text these tools return stands on its own either way.
 *
 * Same rule and same shape as the lifecycle tools in tools.ts.
 */
export function registerAuth(server: McpServer, deps: AuthDeps): void {
    const ports = resolvePorts(deps);
    const supportsUi = deps.supportsUi === true;

    const publish = (name: string, config: AuthToolConfig, handler: () => Promise<CallToolResult>): void => {
        if (supportsUi) {
            registerAppTool(server, name, { ...config, _meta: { ui: { resourceUri: PANEL_RESOURCE_URI } } }, handler as never);
        } else {
            server.registerTool(name, config, handler as never);
        }
    };

    publish(
        "facet_login",
        {
            title: "Sign in to the facet registry",
            description:
                "Sign in to the facet registry. Opens a browser when this server is configured for OAuth; " +
                "otherwise returns step-by-step instructions for minting a token on the website. " +
                "Saves a personal access token to the facet CLI's credentials file.",
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async () => {
            // One read of the environment for the whole invocation: the choice
            // below and everything it leads to see the same configuration.
            const config = readAuthConfig(ports.env, ports.home);

            if (!config.browserFlowAvailable) {
                const body = fallbackMessage(config);
                return text(body, {
                    signedIn: false,
                    mode: "fallback",
                    registryUrl: config.registryUrl,
                    ...card(LOGIN_OPERATION, cardSubject(config), "success", body),
                });
            }
            try {
                const success = await runBrowserLogin(config, ports);
                const body = signedInMessage(success);
                return text(body, {
                    signedIn: true,
                    mode: "browser",
                    username: success.username,
                    email: success.email,
                    tier: success.tier,
                    suspended: success.suspended,
                    registryUrl: config.registryUrl,
                    ...card(LOGIN_OPERATION, cardSubject(config, success.username), "success", body),
                });
            } catch (error) {
                const reason = scrubSecrets(messageOf(error));
                const body = fallbackMessage(config, reason);
                return text(
                    body,
                    {
                        signedIn: false,
                        mode: "fallback",
                        reason,
                        registryUrl: config.registryUrl,
                        ...card(LOGIN_OPERATION, cardSubject(config), "error", body),
                    },
                    true,
                );
            }
        },
    );

    publish(
        "facet_whoami",
        {
            title: "Show the signed-in registry identity",
            description:
                "Report which facet registry account the saved credential belongs to. Reads only; never displays the credential itself.",
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async () => {
            const config = readAuthConfig(ports.env, ports.home);
            const credential = resolveCredential(config);
            if (credential.kind === "absent") {
                const body = notSignedInMessage(config);
                return text(body, {
                    signedIn: false,
                    mode: "fallback",
                    registryUrl: config.registryUrl,
                    ...card(WHOAMI_OPERATION, cardSubject(config), "success", body),
                });
            }
            const where = credential.kind === "env" ? "FACET_TOKEN (environment)" : config.credentialsPath;
            try {
                const identity = await fetchIdentity(config, credential.token, ports);
                const who = identity.email.length > 0 ? `${identity.username} <${identity.email}>` : identity.username;
                const body = [
                    `facet studio · signed in as ${who}`,
                    "",
                    `  tier: ${identity.tier}${identity.suspended ? " (account suspended)" : ""}`,
                    `  credential: ${where}`,
                ].join("\n");
                return text(body, {
                    signedIn: true,
                    mode: credential.kind,
                    username: identity.username,
                    email: identity.email,
                    tier: identity.tier,
                    suspended: identity.suspended,
                    registryUrl: config.registryUrl,
                    ...card(WHOAMI_OPERATION, cardSubject(config, identity.username), "success", body),
                });
            } catch (error) {
                const reason = scrubSecrets(messageOf(error), [credential.token]);
                const body = [
                    `facet studio · couldn't check the saved credential`,
                    "",
                    `  credential: ${where}`,
                    `  problem: ${reason}`,
                    "",
                    fallbackMessage(config),
                ].join("\n");
                return text(
                    body,
                    {
                        signedIn: false,
                        mode: credential.kind,
                        reason,
                        registryUrl: config.registryUrl,
                        ...card(WHOAMI_OPERATION, cardSubject(config), "error", body),
                    },
                    true,
                );
            }
        },
    );
}
