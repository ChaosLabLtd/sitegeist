/**
 * Minimal MCP client over the Streamable HTTP transport.
 *
 * Implements just what Sitegeist needs: lifecycle initialization, tool listing,
 * and tool calls. Requests are POSTed as JSON-RPC 2.0; responses may come back
 * as a single JSON object or as an SSE stream (text/event-stream), both of
 * which are handled here.
 */

import { Value } from "@sinclair/typebox/value";
import {
	InitializeResultSchema,
	type JsonRpcResponse,
	JsonRpcResponseSchema,
	ToolsCallResultSchema,
	ToolsListResultSchema,
} from "./schemas.js";
import type { McpToolDef } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "Sitegeist", version: "1.0.0" };

export interface McpClientOptions {
	url: string;
	/** Static headers (auth, custom). */
	headers?: Record<string, string>;
	/** Called when the server responds 401, with the WWW-Authenticate header. */
	onUnauthorized?: (wwwAuthenticate: string | null) => void;
}

export class McpUnauthorizedError extends Error {
	readonly wwwAuthenticate: string | null;
	constructor(wwwAuthenticate: string | null) {
		super("MCP server requires authorization (401)");
		this.name = "McpUnauthorizedError";
		this.wwwAuthenticate = wwwAuthenticate;
	}
}

/**
 * Extract the first JSON-RPC response object from an SSE body.
 */
function parseSseForResponse(body: string): JsonRpcResponse | undefined {
	for (const block of body.split(/\n\n/)) {
		const dataLines = block
			.split(/\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		if (dataLines.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(dataLines.join("\n"));
			if (Value.Check(JsonRpcResponseSchema, parsed)) return parsed;
		} catch {
			// Not a JSON-RPC response event; skip.
		}
	}
	return undefined;
}

export class McpClient {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private readonly onUnauthorized?: (wwwAuthenticate: string | null) => void;
	private sessionId?: string;
	private nextId = 1;
	private initialized = false;

	constructor(options: McpClientOptions) {
		this.url = options.url;
		this.headers = options.headers ?? {};
		this.onUnauthorized = options.onUnauthorized;
	}

	private async rpc(method: string, params?: Record<string, unknown>, expectResponse = true): Promise<unknown> {
		const id = this.nextId++;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": PROTOCOL_VERSION,
			...this.headers,
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

		const res = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});

		if (res.status === 401) {
			const wwwAuth = res.headers.get("WWW-Authenticate");
			this.onUnauthorized?.(wwwAuth);
			throw new McpUnauthorizedError(wwwAuth);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`MCP request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`);
		}

		const capturedSession = res.headers.get("Mcp-Session-Id");
		if (capturedSession) this.sessionId = capturedSession;

		if (!expectResponse) {
			await res.body?.cancel().catch(() => {});
			return undefined;
		}

		const contentType = res.headers.get("Content-Type") ?? "";
		let rpcResponse: JsonRpcResponse | undefined;
		if (contentType.includes("text/event-stream")) {
			rpcResponse = parseSseForResponse(await res.text());
		} else {
			const json: unknown = await res.json();
			if (Value.Check(JsonRpcResponseSchema, json)) rpcResponse = json;
		}

		if (!rpcResponse) throw new Error(`No JSON-RPC response for ${method}`);
		if (rpcResponse.error) throw new Error(`MCP error (${rpcResponse.error.code}): ${rpcResponse.error.message}`);
		return rpcResponse.result;
	}

	private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": PROTOCOL_VERSION,
			...this.headers,
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
		await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", method, params }),
		}).then((res) => res.body?.cancel().catch(() => {}));
	}

	/**
	 * Perform the initialize handshake. Returns the server's info.
	 */
	async initialize(): Promise<{ name?: string; version?: string }> {
		const result = await this.rpc("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		await this.notify("notifications/initialized");
		this.initialized = true;
		if (Value.Check(InitializeResultSchema, result)) return result.serverInfo ?? {};
		return {};
	}

	/**
	 * List tools advertised by the server.
	 */
	async listTools(): Promise<McpToolDef[]> {
		if (!this.initialized) await this.initialize();
		const tools: McpToolDef[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.rpc("tools/list", cursor ? { cursor } : undefined);
			if (!Value.Check(ToolsListResultSchema, result)) {
				throw new Error("Malformed tools/list response from MCP server");
			}
			for (const tool of result.tools ?? []) {
				tools.push({
					name: tool.name,
					title: tool.title,
					description: tool.description,
					inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	/**
	 * Call a tool and return its raw MCP result (content array + optional error).
	 */
	async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ content: Array<Record<string, unknown>>; isError: boolean; structuredContent?: unknown }> {
		if (!this.initialized) await this.initialize();
		const result = await this.rpc("tools/call", { name, arguments: args });
		if (!Value.Check(ToolsCallResultSchema, result)) {
			throw new Error("Malformed tools/call response from MCP server");
		}
		return {
			content: result.content ?? [],
			isError: result.isError ?? false,
			structuredContent: result.structuredContent,
		};
	}
}
