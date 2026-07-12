/**
 * Renderer for MCP tool calls. A single shared renderer instance is registered
 * under each namespaced MCP tool name as servers connect.
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { Plug } from "lucide";
import type { McpToolDetails } from "./manager.js";

const mcpToolRenderer: ToolRenderer<Record<string, unknown>, McpToolDetails> = {
	render(
		params: Record<string, unknown> | undefined,
		result: ToolResultMessage<McpToolDetails> | undefined,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		const details = result?.details;
		const label = details ? `${details.serverName}: ${details.toolName}` : "MCP tool";

		const argEntries = Object.entries(params ?? {});
		const textOutput = result?.content
			?.filter((c) => c.type === "text")
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		const images = result?.content?.filter((c) => c.type === "image") ?? [];

		return {
			content: html`
				<div class="space-y-2">
					${renderHeader(state, Plug, label)}
					${
						argEntries.length > 0
							? html`<div class="text-xs font-mono text-muted-foreground pl-6 break-all">
								${argEntries.map(([k, v]) => html`<div>${k}: ${JSON.stringify(v)}</div>`)}
							</div>`
							: ""
					}
					${
						textOutput
							? html`<console-block .content=${textOutput} .variant=${result?.isError ? "error" : "default"}></console-block>`
							: ""
					}
					${images.map((c) =>
						c.type === "image"
							? html`<img src="data:${c.mimeType};base64,${c.data}" class="max-w-full rounded" />`
							: "",
					)}
				</div>
			`,
			isCustom: false,
		};
	},
};

const registered = new Set<string>();

/**
 * Ensure a renderer is registered for the given namespaced MCP tool name.
 */
export function ensureMcpToolRenderer(toolName: string): void {
	if (registered.has(toolName)) return;
	registerToolRenderer(toolName, mcpToolRenderer);
	registered.add(toolName);
}
