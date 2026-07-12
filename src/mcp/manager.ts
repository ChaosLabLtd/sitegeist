/**
 * MCP manager: bridges stored server configs, live connections, and the agent.
 *
 * Responsibilities:
 *  - Connect to enabled servers and cache their tool lists.
 *  - Resolve auth headers (bearer / OAuth, refreshing tokens as needed).
 *  - Expose discovered MCP tools as AgentTools the agent can call.
 *  - Drive the interactive OAuth flow and persist tokens.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { McpClient, McpUnauthorizedError } from "./client.js";
import { ensureMcpToolRenderer } from "./McpToolRenderer.js";
import { authorize, ensureValidToken } from "./oauth.js";
import type { McpConnectionState, McpServerConfig, McpToolDef } from "./types.js";

/** Details attached to an MCP tool result message for the renderer. */
export interface McpToolDetails {
	serverId: string;
	serverName: string;
	toolName: string;
	structuredContent?: unknown;
}

/**
 * Sanitize a name into the `[a-zA-Z0-9_-]` charset providers accept.
 */
function slug(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

/**
 * Namespaced tool name so tools from different servers never collide.
 */
export function mcpToolName(server: McpServerConfig, toolName: string): string {
	return `mcp_${slug(server.name) || server.id.slice(0, 8)}_${slug(toolName)}`;
}

class McpManager {
	private readonly states = new Map<string, McpConnectionState>();
	private readonly clients = new Map<string, McpClient>();
	private listeners = new Set<() => void>();

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	getStates(): McpConnectionState[] {
		return [...this.states.values()];
	}

	getState(serverId: string): McpConnectionState | undefined {
		return this.states.get(serverId);
	}

	private setState(serverId: string, patch: Partial<McpConnectionState>): void {
		const prev = this.states.get(serverId);
		if (!prev) return;
		this.states.set(serverId, { ...prev, ...patch });
		this.emit();
	}

	/**
	 * Build the request headers for a server, refreshing OAuth tokens if needed.
	 * Persists refreshed tokens back to storage.
	 */
	private async buildHeaders(server: McpServerConfig): Promise<Record<string, string>> {
		const headers: Record<string, string> = { ...(server.headers ?? {}) };
		if (server.authType === "bearer" && server.bearerToken) {
			headers.Authorization = `Bearer ${server.bearerToken}`;
		} else if (server.authType === "oauth" && server.oauth) {
			const { state, token } = await ensureValidToken(server.oauth);
			if (state !== server.oauth) {
				const updated = { ...server, oauth: state };
				await getSitegeistStorage().mcp.save(updated);
			}
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		return headers;
	}

	/**
	 * Load all stored servers into connection states (without connecting).
	 */
	async load(): Promise<void> {
		const servers = await getSitegeistStorage().mcp.list();
		for (const server of servers) {
			if (!this.states.has(server.id)) {
				this.states.set(server.id, { config: server, status: "disconnected", tools: [] });
			} else {
				this.setState(server.id, { config: server });
			}
		}
		// Drop states for deleted servers.
		const ids = new Set(servers.map((s) => s.id));
		for (const id of [...this.states.keys()]) {
			if (!ids.has(id)) {
				this.states.delete(id);
				this.clients.delete(id);
			}
		}
		this.emit();
	}

	/**
	 * Connect to a single server and fetch its tools.
	 */
	async connect(serverId: string): Promise<void> {
		const state = this.states.get(serverId);
		if (!state) return;
		const server = state.config;
		if (!server.enabled) {
			this.setState(serverId, { status: "disconnected", tools: [], error: undefined });
			return;
		}

		this.setState(serverId, { status: "connecting", error: undefined });
		try {
			const headers = await this.buildHeaders(server);
			const client = new McpClient({ url: server.url, headers });
			const info = await client.initialize();
			const tools = await client.listTools();
			this.clients.set(serverId, client);
			this.setState(serverId, {
				status: "connected",
				tools,
				serverName: info.name,
				serverVersion: info.version,
				error: undefined,
			});
		} catch (err) {
			this.clients.delete(serverId);
			if (err instanceof McpUnauthorizedError) {
				this.setState(serverId, {
					status: "auth-required",
					tools: [],
					error: "Authorization required",
				});
			} else {
				this.setState(serverId, {
					status: "error",
					tools: [],
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Connect to every enabled server.
	 */
	async connectAll(): Promise<void> {
		await this.load();
		await Promise.all(
			this.getStates()
				.filter((s) => s.config.enabled)
				.map((s) => this.connect(s.config.id)),
		);
	}

	disconnect(serverId: string): void {
		this.clients.delete(serverId);
		this.setState(serverId, { status: "disconnected", tools: [] });
	}

	/**
	 * Run the interactive OAuth flow for a server, persist tokens, reconnect.
	 */
	async authenticate(serverId: string): Promise<void> {
		const state = this.states.get(serverId);
		if (!state) return;
		const server = state.config;
		const oauth = await authorize(server.url, server.oauth);
		const updated: McpServerConfig = { ...server, authType: "oauth", oauth };
		await getSitegeistStorage().mcp.save(updated);
		this.setState(serverId, { config: updated });
		await this.connect(serverId);
	}

	private mapContent(items: Array<Record<string, unknown>>): (TextContent | ImageContent)[] {
		const out: (TextContent | ImageContent)[] = [];
		for (const item of items) {
			if (item.type === "text" && typeof item.text === "string") {
				out.push({ type: "text", text: item.text });
			} else if (item.type === "image" && typeof item.data === "string") {
				out.push({ type: "image", data: item.data, mimeType: (item.mimeType as string) ?? "image/png" });
			} else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
				const resource = item.resource as Record<string, unknown>;
				const text = typeof resource.text === "string" ? resource.text : JSON.stringify(resource);
				out.push({ type: "text", text });
			} else {
				out.push({ type: "text", text: JSON.stringify(item) });
			}
		}
		if (out.length === 0) out.push({ type: "text", text: "(no content)" });
		return out;
	}

	/**
	 * Build AgentTools for all connected servers' tools.
	 */
	getAgentTools(): AgentTool<TSchema, McpToolDetails>[] {
		const tools: AgentTool<TSchema, McpToolDetails>[] = [];
		for (const state of this.states.values()) {
			if (state.status !== "connected") continue;
			const server = state.config;
			const client = this.clients.get(server.id);
			if (!client) continue;
			for (const def of state.tools) {
				const tool = this.buildAgentTool(server, client, def);
				ensureMcpToolRenderer(tool.name);
				tools.push(tool);
			}
		}
		return tools;
	}

	private buildAgentTool(
		server: McpServerConfig,
		client: McpClient,
		def: McpToolDef,
	): AgentTool<TSchema, McpToolDetails> {
		const description = def.description ?? def.title ?? def.name;
		return {
			label: def.title ?? def.name,
			name: mcpToolName(server, def.name),
			description: `[${server.name}] ${description}`,
			// MCP inputSchema is already JSON Schema, which providers consume directly.
			parameters: def.inputSchema as unknown as TSchema,
			execute: async (_toolCallId, params): Promise<AgentToolResult<McpToolDetails>> => {
				const result = await client.callTool(def.name, (params ?? {}) as Record<string, unknown>);
				const content = this.mapContent(result.content);
				if (result.isError) {
					const text = content.map((c) => (c.type === "text" ? c.text : "[non-text content]")).join("\n");
					throw new Error(text || `MCP tool ${def.name} returned an error`);
				}
				return {
					content,
					details: {
						serverId: server.id,
						serverName: server.name,
						toolName: def.name,
						structuredContent: result.structuredContent,
					},
				};
			},
		};
	}
}

/** Singleton manager shared across the app. */
export const mcpManager = new McpManager();
