/**
 * TypeBox schemas for MCP JSON-RPC wire messages.
 *
 * MCP responses are external, untrusted input, so we validate them at the
 * boundary with `Value.Check` (interpretive — CSP-safe in the extension) and
 * read from the narrowed value instead of asserting inline shapes.
 */

import { type Static, Type } from "@sinclair/typebox";

export const JsonRpcResponseSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: Type.Union([Type.Number(), Type.String()]),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(
		Type.Object({
			code: Type.Number(),
			message: Type.String(),
			data: Type.Optional(Type.Unknown()),
		}),
	),
});
export type JsonRpcResponse = Static<typeof JsonRpcResponseSchema>;

export const InitializeResultSchema = Type.Object({
	serverInfo: Type.Optional(
		Type.Object({
			name: Type.Optional(Type.String()),
			version: Type.Optional(Type.String()),
		}),
	),
});

export const ToolsListResultSchema = Type.Object({
	tools: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				title: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			}),
		),
	),
	nextCursor: Type.Optional(Type.String()),
});

export const ToolsCallResultSchema = Type.Object({
	content: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
	isError: Type.Optional(Type.Boolean()),
	structuredContent: Type.Optional(Type.Unknown()),
});

/** OAuth Protected Resource Metadata (RFC 9728), permissive subset. */
export const ProtectedResourceMetadataSchema = Type.Object({
	resource: Type.Optional(Type.String()),
	authorization_servers: Type.Optional(Type.Array(Type.String())),
	scopes_supported: Type.Optional(Type.Array(Type.String())),
});

/** OAuth Authorization Server Metadata (RFC 8414 / OIDC), permissive subset. */
export const AuthServerMetadataSchema = Type.Object({
	issuer: Type.Optional(Type.String()),
	authorization_endpoint: Type.Optional(Type.String()),
	token_endpoint: Type.Optional(Type.String()),
	registration_endpoint: Type.Optional(Type.String()),
});

/** Dynamic Client Registration response (RFC 7591), permissive subset. */
export const ClientRegistrationResponseSchema = Type.Object({
	client_id: Type.String(),
	client_secret: Type.Optional(Type.String()),
});

/** OAuth token endpoint response, permissive subset. */
export const TokenResponseSchema = Type.Object({
	access_token: Type.String(),
	refresh_token: Type.Optional(Type.String()),
	expires_in: Type.Optional(Type.Number()),
	token_type: Type.Optional(Type.String()),
});
