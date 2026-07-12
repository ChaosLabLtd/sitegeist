import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";
import {
	completeSimple,
	type ImageContent,
	isContextOverflow,
	type Message,
	type Model,
	type TextContent,
	type Usage,
} from "@mariozechner/pi-ai";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { Toast } from "./components/Toast.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		compactionSummary: CompactionSummaryMessage;
	}
}

export interface AutoCompactSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_AUTO_COMPACT_SETTINGS: AutoCompactSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Read the conversation and produce only the requested structured checkpoint summary. Do not continue the conversation.";

const SUMMARY_PROMPT = `Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this exact format:

## Goal
[What the user is trying to accomplish.]

## Constraints & Preferences
- [Important user constraints, preferences, and requirements.]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current unfinished work]

### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Next concrete step]

## Critical Context
- [Exact file paths, URLs, commands, model IDs, errors, and facts needed to continue.]

Be concise but preserve details needed to resume without reading the discarded messages.`;

const UPDATE_SUMMARY_PROMPT = `Update the existing summary with the new conversation messages.

Rules:
- Preserve still-relevant information from the previous summary.
- Add new progress, decisions, constraints, exact file paths, commands, model IDs, errors, and facts.
- Move completed items from In Progress to Done.
- Remove stale next steps only when they were completed or are no longer relevant.

Use the same structured format as the previous summary.`;

function isUiOnlyMessage(message: AgentMessage): boolean {
	return message.role === "artifact" || message.role === "welcome";
}

function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function textBlockChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += 4800;
		}
	}
	return chars;
}

function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	if (message.role === "user") {
		chars = textBlockChars(message.content);
	} else if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "thinking") {
				chars += block.thinking.length;
			} else if (block.type === "toolCall") {
				chars += block.name.length + JSON.stringify(block.arguments).length;
			}
		}
	} else if (message.role === "toolResult") {
		chars = textBlockChars(message.content);
	} else if (message.role === "navigation") {
		const nav = message as {
			url: string;
			title: string;
			skillsOutput?: string;
		};
		chars = nav.url.length + nav.title.length + (nav.skillsOutput?.length || 0);
	} else if (message.role === "compactionSummary") {
		chars = message.summary.length;
	} else if (message.role === "user-with-attachments") {
		const user = message as {
			content: string | Array<TextContent | ImageContent>;
			attachments?: unknown[];
		};
		chars = textBlockChars(user.content) + (user.attachments?.length || 0) * 4800;
	}

	return Math.ceil(chars / 4);
}

function getAssistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
		return undefined;
	}
	return message.usage;
}

function estimateContextTokens(messages: AgentMessage[]): number {
	let estimated = 0;
	let lastUsage: { usage: Usage; index: number } | undefined;

	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) {
			lastUsage = { usage, index: i };
			break;
		}
	}

	if (lastUsage) {
		estimated = calculateContextTokens(lastUsage.usage);
		for (let i = lastUsage.index + 1; i < messages.length; i++) {
			estimated += estimateTokens(messages[i]);
		}
		return estimated;
	}

	for (const message of messages) {
		estimated += estimateTokens(message);
	}
	return estimated;
}

function collectToolCallIds(messages: AgentMessage[], startIndex: number): Set<string> {
	const ids = new Set<string>();
	for (let i = startIndex; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.add(block.id);
		}
	}
	return ids;
}

function findSafeCutIndex(messages: AgentMessage[], boundaryStart: number, keepRecentTokens: number): number {
	let accumulated = 0;
	let cutIndex = messages.length;

	for (let i = messages.length - 1; i >= boundaryStart; i--) {
		if (isUiOnlyMessage(messages[i])) continue;
		accumulated += estimateTokens(messages[i]);
		cutIndex = i;
		if (accumulated >= keepRecentTokens) break;
	}

	while (cutIndex > boundaryStart) {
		const keptToolCallIds = collectToolCallIds(messages, cutIndex);
		const firstInvalidToolResultIndex = messages.findIndex(
			(message, index) =>
				index >= cutIndex && message.role === "toolResult" && !keptToolCallIds.has(message.toolCallId),
		);
		if (firstInvalidToolResultIndex === -1) break;
		cutIndex--;
	}

	return cutIndex;
}

function getPreviousSummary(messages: AgentMessage[]): { summary: string; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "compactionSummary") {
			return { summary: message.summary, index: i };
		}
	}
	return undefined;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const content = typeof message.content === "string" ? message.content : textBlockCharsToText(message.content);
			if (content) parts.push(`[User]: ${content}`);
		} else if (message.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of message.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					toolCalls.push(`${block.name}(${JSON.stringify(block.arguments)})`);
				}
			}

			if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const content = textBlockCharsToText(message.content);
			if (content) parts.push(`[Tool result]: ${truncate(content, 2000)}`);
		}
	}

	return parts.join("\n\n");
}

function textBlockCharsToText(content: Array<TextContent | ImageContent>): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function summarizeMessages(
	messages: AgentMessage[],
	previousSummary: string | undefined,
	model: Model<any>,
	apiKey: string,
	reserveTokens: number,
	signal: AbortSignal,
): Promise<string> {
	const llmMessages = await browserMessageTransformer(messages);
	const conversationText = serializeConversation(llmMessages);
	const prompt = previousSummary
		? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n<new-conversation>\n${conversationText}\n</new-conversation>\n\n${UPDATE_SUMMARY_PROMPT}`
		: `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARY_PROMPT}`;

	const response = await completeSimple(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			maxTokens: Math.floor(reserveTokens * 0.8),
			reasoning: model.reasoning ? "high" : undefined,
			signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Summarization failed");
	}

	return response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export interface AutoCompactorOptions {
	agent: Agent;
	getApiKey: (provider: string) => Promise<string | undefined>;
	getSettings?: () => Promise<AutoCompactSettings>;
	onCompacted?: () => void | Promise<void>;
}

export class AutoCompactor {
	private unsubscribe?: () => void;
	private abortController?: AbortController;
	private compacting = false;
	private currentCompaction?: Promise<boolean>;

	constructor(private readonly options: AutoCompactorOptions) {
		this.unsubscribe = options.agent.subscribe((event) => {
			if (event.type === "agent_end") {
				this.compactIfNeeded().catch((error) => console.error("Auto-compaction failed:", error));
			}
		});
	}

	destroy(): void {
		this.unsubscribe?.();
		this.abortController?.abort();
	}

	async compactIfNeeded(force = false): Promise<boolean> {
		if (this.currentCompaction) {
			return this.currentCompaction;
		}
		this.currentCompaction = this.runCompactionIfNeeded(force).finally(() => {
			this.currentCompaction = undefined;
		});
		return this.currentCompaction;
	}

	private async runCompactionIfNeeded(force: boolean): Promise<boolean> {
		const { agent } = this.options;
		if (this.compacting || agent.state.isStreaming) return false;

		const settings = this.options.getSettings ? await this.options.getSettings() : DEFAULT_AUTO_COMPACT_SETTINGS;
		if (!force && !settings.enabled) return false;

		const messages = agent.state.messages;
		if (messages.length === 0) return false;

		const contextTokens = estimateContextTokens(messages);
		const contextWindow = agent.state.model.contextWindow || 200000;
		const overflow = this.hasOverflowMessage(messages, contextWindow);
		if (!force && !overflow && contextTokens <= contextWindow - settings.reserveTokens) {
			return false;
		}

		const previous = getPreviousSummary(messages);
		const boundaryStart = previous ? previous.index + 1 : 0;
		const cutIndex = findSafeCutIndex(messages, boundaryStart, settings.keepRecentTokens);
		const messagesToSummarize = messages
			.slice(boundaryStart, cutIndex)
			.filter((message) => !isUiOnlyMessage(message) && message.role !== "compactionSummary");

		if (messagesToSummarize.length === 0) return false;

		this.compacting = true;
		this.abortController = new AbortController();
		const toast = Toast.show("Compacting context...", "info", 0);

		try {
			const apiKey = await this.options.getApiKey(agent.state.model.provider);
			if (!apiKey) throw new Error(`No API key for provider: ${agent.state.model.provider}`);

			const summary = await summarizeMessages(
				messagesToSummarize,
				previous?.summary,
				agent.state.model,
				apiKey,
				settings.reserveTokens,
				this.abortController.signal,
			);

			agent.replaceMessages(
				this.buildCompactedMessages(messages, previous?.index, cutIndex, summary, contextTokens),
			);
			await this.options.onCompacted?.();
			toast.dismiss();
			Toast.success("Context compacted");
			return true;
		} catch (error) {
			toast.dismiss();
			Toast.error(`Auto-compact failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			this.compacting = false;
			this.abortController = undefined;
		}
	}

	private hasOverflowMessage(messages: AgentMessage[], contextWindow: number): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			return isContextOverflow(message, contextWindow);
		}
		return false;
	}

	private buildCompactedMessages(
		messages: AgentMessage[],
		previousSummaryIndex: number | undefined,
		cutIndex: number,
		summary: string,
		tokensBefore: number,
	): AgentMessage[] {
		const result: AgentMessage[] = [];
		const summaryMessage: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary,
			tokensBefore,
			timestamp: Date.now(),
		};

		for (let i = 0; i < messages.length; i++) {
			if (i === cutIndex) {
				result.push(summaryMessage);
			}
			if (i === previousSummaryIndex) {
				continue;
			}
			if (i < cutIndex && i > (previousSummaryIndex ?? -1) && !isUiOnlyMessage(messages[i])) {
				continue;
			}
			result.push(messages[i]);
		}

		if (cutIndex === messages.length) {
			result.push(summaryMessage);
		}

		return result;
	}
}

export function registerAutoCompactRenderer(): void {
	registerMessageRenderer("compactionSummary", {
		render: (message: CompactionSummaryMessage) => html`
			<div class="mx-4 my-2 text-xs text-muted-foreground">
				Context compacted at ${new Date(message.timestamp).toLocaleTimeString()} (${message.tokensBefore.toLocaleString()} tokens).
			</div>
		`,
	});
}
