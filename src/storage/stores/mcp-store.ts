import { Store, type StoreConfig } from "@mariozechner/pi-web-ui";
import type { McpServerConfig } from "../../mcp/types.js";

/**
 * Store for user-configured MCP servers.
 */
export class McpStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "mcp_servers",
		};
	}

	async get(id: string): Promise<McpServerConfig | null> {
		return this.getBackend().get("mcp_servers", id);
	}

	async save(server: McpServerConfig): Promise<void> {
		await this.getBackend().set("mcp_servers", server.id, server);
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().delete("mcp_servers", id);
	}

	async list(): Promise<McpServerConfig[]> {
		const keys = await this.getBackend().keys("mcp_servers");
		const servers = await Promise.all(keys.map((key) => this.getBackend().get<McpServerConfig>("mcp_servers", key)));
		return servers
			.filter((s): s is McpServerConfig => s !== null)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
}
