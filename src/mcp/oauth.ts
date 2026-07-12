/**
 * OAuth 2.1 support for remote MCP servers.
 *
 * Implements the MCP authorization flow:
 *  1. Protected Resource Metadata discovery (RFC 9728)
 *  2. Authorization Server Metadata discovery (RFC 8414 / OIDC)
 *  3. Dynamic Client Registration (RFC 7591)
 *  4. Authorization Code + PKCE with Resource Indicators (RFC 8707)
 *
 * Browser-specific: instead of a local callback server we open a tab and watch
 * for the redirect to a localhost URL, reusing the extension's OAuth helpers.
 */

import { Value } from "@sinclair/typebox/value";
import { generatePKCE, generateState, waitForOAuthRedirect } from "../oauth/browser-oauth.js";
import {
	AuthServerMetadataSchema,
	ClientRegistrationResponseSchema,
	ProtectedResourceMetadataSchema,
	TokenResponseSchema,
} from "./schemas.js";
import type { McpOAuthState } from "./types.js";

const REDIRECT_PORT = 53927;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/mcp-callback`;
const REDIRECT_HOST = `localhost:${REDIRECT_PORT}`;
const CLIENT_NAME = "Sitegeist";
// Refresh access tokens this many ms before they actually expire.
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Extract an OAuth error code (e.g. "invalid_target") from a response body,
 * whether JSON or otherwise. Returns undefined if none is present.
 */
function oauthErrorCode(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			const code = (parsed as { error: unknown }).error;
			if (typeof code === "string") return code;
		}
	} catch {
		// Not JSON.
	}
	return undefined;
}

/**
 * Fetch and parse a JSON body. Throws a readable error (never a raw
 * "Unexpected token '<'") when the endpoint returns HTML or an OAuth error.
 */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	const body = await res.text().catch(() => "");
	if (!res.ok) {
		const code = oauthErrorCode(body);
		throw new Error(code ? code : `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`Expected JSON from ${new URL(url).host} but received a non-JSON response`);
	}
}

/**
 * Parse the `resource_metadata` pointer out of a WWW-Authenticate header.
 */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | undefined {
	if (!wwwAuthenticate) return undefined;
	const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/i);
	return match?.[1];
}

/**
 * Build candidate Protected Resource Metadata URLs for a server URL.
 * Prefers the explicit pointer, then falls back to the well-known path with
 * and without the resource path suffix (per RFC 9728 path insertion).
 */
function protectedResourceMetadataUrls(serverUrl: string, pointer?: string): string[] {
	if (pointer) return [pointer];
	const u = new URL(serverUrl);
	const path = u.pathname.replace(/\/$/, "");
	const urls = [`${u.origin}/.well-known/oauth-protected-resource${path}`];
	if (path) urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
	return urls;
}

/**
 * Build candidate Authorization Server Metadata URLs for an issuer.
 */
function authServerMetadataUrls(issuer: string): string[] {
	const u = new URL(issuer);
	const path = u.pathname.replace(/\/$/, "");
	const urls: string[] = [];
	// RFC 8414 inserts the well-known segment before the issuer path.
	urls.push(`${u.origin}/.well-known/oauth-authorization-server${path}`);
	urls.push(`${u.origin}/.well-known/openid-configuration${path}`);
	if (path) {
		urls.push(`${u.origin}${path}/.well-known/oauth-authorization-server`);
		urls.push(`${u.origin}${path}/.well-known/openid-configuration`);
	}
	return urls;
}

/**
 * Discover authorization endpoints for a server. Returns a partial OAuth state
 * with endpoints filled in; throws if discovery fails entirely.
 */
export async function discoverOAuth(serverUrl: string, wwwAuthenticate?: string | null): Promise<McpOAuthState> {
	// Default resource to the server URL, but do NOT mark it confirmed: many
	// auth servers reject an unknown `resource` with invalid_target, so we only
	// send it when Protected Resource Metadata explicitly advertises it.
	const state: McpOAuthState = { resource: serverUrl };

	// Step 1: Protected Resource Metadata (best effort).
	let issuer: string | undefined;
	for (const url of protectedResourceMetadataUrls(serverUrl, parseResourceMetadataUrl(wwwAuthenticate ?? null))) {
		try {
			const prm = await fetchJson(url);
			if (!Value.Check(ProtectedResourceMetadataSchema, prm)) continue;
			if (prm.resource) state.resource = prm.resource;
			// PRM was served, so the resource indicator is expected by this AS.
			state.resourceConfirmed = true;
			if (prm.authorization_servers?.[0]) {
				issuer = prm.authorization_servers[0];
			}
			if (prm.scopes_supported) state.scope = prm.scopes_supported.join(" ");
			break;
		} catch {
			// Try next candidate.
		}
	}

	// Fallback: assume the authorization server lives at the server origin.
	if (!issuer) issuer = new URL(serverUrl).origin;
	state.issuer = issuer;

	// Step 2: Authorization Server Metadata.
	for (const url of authServerMetadataUrls(issuer)) {
		try {
			const asMeta = await fetchJson(url);
			if (!Value.Check(AuthServerMetadataSchema, asMeta)) continue;
			if (asMeta.authorization_endpoint) state.authorizationEndpoint = asMeta.authorization_endpoint;
			if (asMeta.token_endpoint) state.tokenEndpoint = asMeta.token_endpoint;
			if (asMeta.registration_endpoint) state.registrationEndpoint = asMeta.registration_endpoint;
			break;
		} catch {
			// Try next candidate.
		}
	}

	// Sensible defaults if the AS did not publish full metadata.
	state.authorizationEndpoint ??= `${new URL(issuer).origin}/authorize`;
	state.tokenEndpoint ??= `${new URL(issuer).origin}/token`;

	return state;
}

/**
 * Register a client via Dynamic Client Registration. Mutates and returns state.
 */
async function registerClient(state: McpOAuthState): Promise<McpOAuthState> {
	if (state.clientId) return state;
	if (!state.registrationEndpoint) {
		throw new Error(
			"This MCP server requires OAuth but does not support Dynamic Client Registration. Manual client credentials are not yet supported.",
		);
	}

	const body: Record<string, unknown> = {
		client_name: CLIENT_NAME,
		redirect_uris: [REDIRECT_URI],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	if (state.scope) body.scope = state.scope;

	const reg = await fetchJson(state.registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!Value.Check(ClientRegistrationResponseSchema, reg)) {
		throw new Error("Dynamic client registration did not return a client_id");
	}
	state.clientId = reg.client_id;
	if (reg.client_secret) state.clientSecret = reg.client_secret;
	return state;
}

function applyTokenResponse(state: McpOAuthState, token: unknown): void {
	if (!Value.Check(TokenResponseSchema, token)) throw new Error("Token response missing access_token");
	state.accessToken = token.access_token;
	if (token.refresh_token) state.refreshToken = token.refresh_token;
	const expiresIn = token.expires_in ?? 3600;
	state.expiresAt = Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS;
}

/**
 * POST to the token endpoint. Sends the RFC 8707 `resource` parameter only when
 * it was confirmed via Protected Resource Metadata; if the AS still rejects it
 * with invalid_target, retries once without it.
 */
async function requestToken(state: McpOAuthState, baseBody: Record<string, string>): Promise<unknown> {
	const withResource = { ...baseBody };
	if (state.resource && state.resourceConfirmed) withResource.resource = state.resource;

	try {
		return await fetchJson(state.tokenEndpoint!, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(withResource).toString(),
		});
	} catch (err) {
		const isInvalidTarget = err instanceof Error && err.message.includes("invalid_target");
		if (!isInvalidTarget || !("resource" in withResource)) throw err;
		// Retry without the resource indicator.
		return fetchJson(state.tokenEndpoint!, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(baseBody).toString(),
		});
	}
}

/**
 * Run the full interactive OAuth authorization flow. Opens a browser tab for
 * user consent and returns fully populated OAuth state with tokens.
 */
export async function authorize(serverUrl: string, existing?: McpOAuthState): Promise<McpOAuthState> {
	let state = existing?.authorizationEndpoint ? { ...existing } : await discoverOAuth(serverUrl, null);
	if (existing) state = { ...state, ...existing, resource: state.resource ?? existing.resource };

	state = await registerClient(state);

	const { verifier, challenge } = await generatePKCE();
	const csrf = generateState();

	const authParams = new URLSearchParams({
		response_type: "code",
		client_id: state.clientId!,
		redirect_uri: REDIRECT_URI,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: csrf,
	});
	if (state.scope) authParams.set("scope", state.scope);
	if (state.resource && state.resourceConfirmed) authParams.set("resource", state.resource);

	const redirectUrl = await waitForOAuthRedirect(
		`${state.authorizationEndpoint}?${authParams.toString()}`,
		REDIRECT_HOST,
	);

	const code = redirectUrl.searchParams.get("code");
	const returnedState = redirectUrl.searchParams.get("state");
	const authError = redirectUrl.searchParams.get("error");
	if (authError) throw new Error(`Authorization failed: ${authError}`);
	if (!code) throw new Error("Missing authorization code in redirect");
	if (returnedState !== csrf) throw new Error("OAuth state mismatch");

	const tokenBody: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		client_id: state.clientId!,
		code_verifier: verifier,
	};
	if (state.clientSecret) tokenBody.client_secret = state.clientSecret;

	const token = await requestToken(state, tokenBody);
	applyTokenResponse(state, token);
	return state;
}

/**
 * Refresh an access token using the stored refresh token. Returns updated state.
 */
export async function refreshToken(state: McpOAuthState): Promise<McpOAuthState> {
	if (!state.refreshToken || !state.tokenEndpoint || !state.clientId) {
		throw new Error("Cannot refresh: missing refresh token or client registration");
	}
	const body: Record<string, string> = {
		grant_type: "refresh_token",
		refresh_token: state.refreshToken,
		client_id: state.clientId,
	};
	if (state.clientSecret) body.client_secret = state.clientSecret;

	const token = await requestToken(state, body);
	const updated = { ...state };
	applyTokenResponse(updated, token);
	return updated;
}

/**
 * Return a valid access token, refreshing if expired. Returns the (possibly
 * updated) state alongside the token so callers can persist new tokens.
 */
export async function ensureValidToken(
	state: McpOAuthState,
): Promise<{ state: McpOAuthState; token: string | undefined }> {
	if (!state.accessToken) return { state, token: undefined };
	if (!state.expiresAt || Date.now() < state.expiresAt) {
		return { state, token: state.accessToken };
	}
	if (state.refreshToken) {
		try {
			const refreshed = await refreshToken(state);
			return { state: refreshed, token: refreshed.accessToken };
		} catch {
			// Refresh failed; token is stale and re-auth is required.
			return { state, token: undefined };
		}
	}
	return { state, token: undefined };
}
