/**
 * Shared types for Model Context Protocol (MCP) support.
 *
 * Sitegeist runs as a browser extension with no ability to spawn local
 * processes, so it connects to *remote* MCP servers over the Streamable HTTP
 * transport. stdio servers are not supported.
 */

export type McpAuthType = "none" | "bearer" | "oauth";

/**
 * OAuth 2.1 state discovered and negotiated for a server.
 * Persisted so tokens survive reloads and can be refreshed.
 */
export interface McpOAuthState {
	/** Canonical resource identifier (the MCP server URL) used for RFC 8707. */
	resource?: string;
	/** Authorization server issuer base URL. */
	issuer?: string;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	registrationEndpoint?: string;
	/** Scopes requested (space separated). */
	scope?: string;
	/** Client credentials obtained via dynamic client registration. */
	clientId?: string;
	clientSecret?: string;
	/** Tokens. */
	accessToken?: string;
	refreshToken?: string;
	/** Epoch millis when the access token expires (with safety margin). */
	expiresAt?: number;
}

/**
 * A user-configured MCP server.
 */
export interface McpServerConfig {
	id: string;
	name: string;
	/** Streamable HTTP endpoint URL. */
	url: string;
	enabled: boolean;
	authType: McpAuthType;
	/** Static bearer token (authType === "bearer"). */
	bearerToken?: string;
	/** Extra headers sent with every request. */
	headers?: Record<string, string>;
	/** OAuth state (authType === "oauth"). */
	oauth?: McpOAuthState;
	createdAt: string;
}

/**
 * A tool advertised by an MCP server (subset of the MCP schema we use).
 */
export interface McpToolDef {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "auth-required" | "error";

/**
 * Live connection state for a server, surfaced to the settings UI.
 */
export interface McpConnectionState {
	config: McpServerConfig;
	status: McpConnectionStatus;
	tools: McpToolDef[];
	error?: string;
	serverName?: string;
	serverVersion?: string;
}
