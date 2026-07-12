import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { CheckCircle2, Loader2, Lock, Plug, Trash2, XCircle } from "lucide";
import { Toast } from "../components/Toast.js";
import { mcpManager } from "../mcp/manager.js";
import type { McpAuthType, McpConnectionState } from "../mcp/types.js";
import { getSitegeistStorage } from "../storage/app-storage.js";

@customElement("mcp-tab")
export class McpTab extends SettingsTab {
	@state() private states: McpConnectionState[] = [];
	@state() private authenticatingId: string | null = null;
	// Add-server form fields.
	@state() private newName = "";
	@state() private newUrl = "";
	@state() private newAuthType: McpAuthType = "none";
	@state() private newToken = "";

	private unsubscribe?: () => void;

	getTabName(): string {
		return "MCP Servers";
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.unsubscribe = mcpManager.subscribe(() => {
			this.states = mcpManager.getStates();
		});
		await mcpManager.load();
		this.states = mcpManager.getStates();
		// Connect any enabled servers that are not connected yet.
		mcpManager.connectAll().catch(() => {});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.unsubscribe?.();
	}

	private async addServer() {
		const name = this.newName.trim();
		const url = this.newUrl.trim();
		if (!name || !url) {
			Toast.error("Name and URL are required");
			return;
		}
		try {
			new URL(url);
		} catch {
			Toast.error("Invalid server URL");
			return;
		}

		const storage = getSitegeistStorage();
		await storage.mcp.save({
			id: crypto.randomUUID(),
			name,
			url,
			enabled: true,
			authType: this.newAuthType,
			bearerToken: this.newAuthType === "bearer" ? this.newToken.trim() : undefined,
			createdAt: new Date().toISOString(),
		});

		this.newName = "";
		this.newUrl = "";
		this.newAuthType = "none";
		this.newToken = "";
		await mcpManager.load();
		this.states = mcpManager.getStates();
		await mcpManager.connectAll();
	}

	private async deleteServer(id: string, name: string) {
		if (!confirm(`Delete MCP server "${name}"?`)) return;
		mcpManager.disconnect(id);
		await getSitegeistStorage().mcp.delete(id);
		await mcpManager.load();
		this.states = mcpManager.getStates();
	}

	private async toggleEnabled(state: McpConnectionState) {
		const updated = { ...state.config, enabled: !state.config.enabled };
		await getSitegeistStorage().mcp.save(updated);
		await mcpManager.load();
		if (updated.enabled) {
			await mcpManager.connect(updated.id);
		} else {
			mcpManager.disconnect(updated.id);
		}
	}

	private async authenticate(id: string) {
		this.authenticatingId = id;
		try {
			await mcpManager.authenticate(id);
			Toast.success("Authenticated successfully");
		} catch (err) {
			Toast.error(err instanceof Error ? err.message : "Authentication failed");
		} finally {
			this.authenticatingId = null;
		}
	}

	private renderStatusBadge(state: McpConnectionState): TemplateResult {
		switch (state.status) {
			case "connected":
				return html`<span class="flex items-center gap-1 text-xs text-green-600 dark:text-green-500">
					${icon(CheckCircle2, "sm")} Connected${state.tools.length ? ` · ${state.tools.length} tools` : ""}
				</span>`;
			case "connecting":
				return html`<span class="flex items-center gap-1 text-xs text-muted-foreground">
					<span class="animate-spin inline-block">${icon(Loader2, "sm")}</span> Connecting…
				</span>`;
			case "auth-required":
				return html`<span class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
					${icon(Lock, "sm")} Authorization required
				</span>`;
			case "error":
				return html`<span class="flex items-center gap-1 text-xs text-destructive" title=${state.error ?? ""}>
					${icon(XCircle, "sm")} ${state.error ?? "Error"}
				</span>`;
			default:
				return html`<span class="text-xs text-muted-foreground">Disconnected</span>`;
		}
	}

	private renderServer(state: McpConnectionState): TemplateResult {
		const server = state.config;
		const busy = this.authenticatingId === server.id;
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-3">
				<div class="flex items-start justify-between gap-3">
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="font-medium text-foreground truncate">${server.name}</span>
							<span class="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1">
								${server.authType}
							</span>
						</div>
						<div class="text-xs text-muted-foreground truncate">${server.url}</div>
						<div class="mt-1">${this.renderStatusBadge(state)}</div>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<label class="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
							<input
								type="checkbox"
								.checked=${server.enabled}
								@change=${() => this.toggleEnabled(state)}
							/>
							Enabled
						</label>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Trash2, "sm"),
							onClick: () => this.deleteServer(server.id, server.name),
							title: "Delete",
						})}
					</div>
				</div>

				${
					state.status === "auth-required" || (server.authType === "oauth" && state.status === "error")
						? html`<div>
							${Button({
								variant: "default",
								size: "sm",
								disabled: busy,
								loading: busy,
								onClick: () => this.authenticate(server.id),
								children: server.oauth?.accessToken ? "Re-authenticate" : "Authenticate",
							})}
						</div>`
						: ""
				}
				${
					state.status === "error" && server.authType !== "oauth"
						? html`<div>
							${Button({
								variant: "outline",
								size: "sm",
								onClick: () => mcpManager.connect(server.id),
								children: "Retry",
							})}
						</div>`
						: ""
				}

				${
					state.tools.length > 0
						? html`<div class="border-t border-border pt-2">
							<div class="text-xs font-medium text-muted-foreground mb-1">Tools</div>
							<div class="flex flex-wrap gap-1">
								${state.tools.map(
									(t) => html`<span
										class="text-[11px] font-mono bg-muted text-foreground rounded px-1.5 py-0.5"
										title=${t.description ?? ""}
									>${t.name}</span>`,
								)}
							</div>
						</div>`
						: ""
				}
			</div>
		`;
	}

	private renderAddForm(): TemplateResult {
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-3">
				<h3 class="font-semibold text-foreground flex items-center gap-2">${icon(Plug, "sm")} Add MCP Server</h3>
				<p class="text-xs text-muted-foreground">
					Connect a remote MCP server over Streamable HTTP. Local (stdio) servers are not supported in the browser.
				</p>
				${Input({
					label: "Name",
					type: "text",
					placeholder: "My MCP Server",
					value: this.newName,
					onInput: (e) => {
						this.newName = (e.target as HTMLInputElement).value;
					},
				})}
				${Input({
					label: "Server URL",
					type: "text",
					placeholder: "https://example.com/mcp",
					value: this.newUrl,
					onInput: (e) => {
						this.newUrl = (e.target as HTMLInputElement).value;
					},
				})}
				<div class="space-y-1">
					<label class="text-sm font-medium text-foreground">Authentication</label>
					<select
						class="w-full px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
						.value=${this.newAuthType}
						@change=${(e: Event) => {
							this.newAuthType = (e.target as HTMLSelectElement).value as McpAuthType;
						}}
					>
						<option value="none">None</option>
						<option value="bearer">Bearer token</option>
						<option value="oauth">OAuth (authorize after adding)</option>
					</select>
				</div>
				${
					this.newAuthType === "bearer"
						? Input({
								label: "Bearer token",
								type: "password",
								placeholder: "Token",
								value: this.newToken,
								onInput: (e: Event) => {
									this.newToken = (e.target as HTMLInputElement).value;
								},
							})
						: ""
				}
				<div class="flex justify-end">
					${Button({
						variant: "default",
						onClick: () => this.addServer(),
						children: "Add Server",
					})}
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">
					Model Context Protocol servers expose tools that Sitegeist's agent can call. Add remote MCP
					servers and their tools become available in chat automatically.
				</p>

				${this.renderAddForm()}

				${
					this.states.length === 0
						? html`<div class="text-center text-muted-foreground py-8">No MCP servers configured yet</div>`
						: html`<div class="flex flex-col gap-3">
							${this.states.map((s) => this.renderServer(s))}
						</div>`
				}
			</div>
		`;
	}
}
