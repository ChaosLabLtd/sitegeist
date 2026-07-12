import type { Model } from "@mariozechner/pi-ai";
import type { CustomProvider } from "@mariozechner/pi-web-ui";

export const CLIPROXY_PROVIDER_ID = "cliproxyapi";
export const CLIPROXY_BASE_URL = "http://localhost:8317";
export const CLIPROXY_OPUS_MODEL_ID = "claude-opus-4-7";

const CLIPROXY_API_KEY = "dummy";
const LEGACY_CLIPROXY_MODEL_IDS = new Set(["claude-opus-4.7"]);
const FALLBACK_CLIPROXY_MODEL_IDS = ["gpt-5.5", CLIPROXY_OPUS_MODEL_ID];

interface ClipProxyModelInfo {
	id: string;
	owned_by?: string;
	context_length?: number;
	max_tokens?: number;
}

interface ClipProxyModelsResponse {
	data?: ClipProxyModelInfo[];
}

const zeroCost = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function formatModelName(id: string): string {
	return id
		.split(/[/-]/)
		.map((part) => {
			if (["gpt", "oss", "lfm"].includes(part)) return part.toUpperCase();
			if (/^\d/.test(part)) return part;
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function isClaudeModel(id: string, ownedBy?: string): boolean {
	return id.startsWith("claude-") || ownedBy === "anthropic";
}

function isOpenAIResponsesModel(id: string, ownedBy?: string): boolean {
	return ownedBy === "openai" || id.startsWith("gpt-") || id.startsWith("codex-");
}

function isReasoningModel(id: string): boolean {
	return (
		id.includes("thinking") ||
		id.includes("reason") ||
		id.startsWith("gpt-5") ||
		id.startsWith("claude-opus-") ||
		id.startsWith("claude-sonnet-4") ||
		id.startsWith("claude-3-7") ||
		id.startsWith("gemini-3") ||
		id.startsWith("qwen3")
	);
}

function getContextWindow(id: string, ownedBy: string | undefined, contextLength: number | undefined): number {
	if (contextLength) return contextLength;
	if (isClaudeModel(id, ownedBy)) return 200000;
	if (id.startsWith("gpt-5") || id.startsWith("codex-")) return 400000;
	if (id.startsWith("gemini-")) return 1048576;
	return 128000;
}

function getMaxTokens(id: string, ownedBy: string | undefined, maxTokens: number | undefined): number {
	if (maxTokens) return maxTokens;
	if (isClaudeModel(id, ownedBy)) return 128000;
	if (id.startsWith("gpt-5") || id.startsWith("codex-")) return 128000;
	return 32768;
}

function createClipProxyModel(provider: string, baseUrl: string, info: ClipProxyModelInfo): Model<any> {
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
	const api = isClaudeModel(info.id, info.owned_by)
		? "anthropic-messages"
		: isOpenAIResponsesModel(info.id, info.owned_by)
			? "openai-responses"
			: "openai-completions";

	return {
		id: info.id,
		name: formatModelName(info.id),
		api,
		provider,
		baseUrl: api === "anthropic-messages" ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`,
		reasoning: isReasoningModel(info.id),
		input: ["text", "image"],
		cost: zeroCost,
		contextWindow: getContextWindow(info.id, info.owned_by, info.context_length),
		maxTokens: getMaxTokens(info.id, info.owned_by, info.max_tokens),
	};
}

function createClipProxyModels(provider: string, baseUrl: string, modelInfos: ClipProxyModelInfo[]): Model<any>[] {
	return modelInfos
		.filter((model) => model.id && !model.id.startsWith("gpt-image-"))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((model) => createClipProxyModel(provider, baseUrl, model));
}

function createFallbackModelInfos(): ClipProxyModelInfo[] {
	return FALLBACK_CLIPROXY_MODEL_IDS.map((id) => ({
		id,
		owned_by: id.startsWith("claude-") ? "anthropic" : "openai",
	}));
}

function isGeneratedClipProxyModel(model: Model<any>, provider: string, baseUrl: string): boolean {
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
	return (
		model.provider === provider &&
		(model.baseUrl === normalizedBaseUrl || model.baseUrl === `${normalizedBaseUrl}/v1`) &&
		(model.api === "anthropic-messages" || model.api === "openai-responses" || model.api === "openai-completions")
	);
}

export async function fetchClipProxyModelInfos(baseUrl = CLIPROXY_BASE_URL): Promise<ClipProxyModelInfo[]> {
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
	const response = await fetch(`${normalizedBaseUrl}/v1/models`, {
		headers: { Authorization: `Bearer ${CLIPROXY_API_KEY}` },
	});
	if (!response.ok) {
		throw new Error(`ClipProxy model discovery failed: HTTP ${response.status}`);
	}
	const data = (await response.json()) as ClipProxyModelsResponse;
	if (!Array.isArray(data.data)) {
		throw new Error("ClipProxy model discovery failed: invalid /v1/models response");
	}
	return data.data;
}

export function createClipProxyProvider(
	existing?: CustomProvider | null,
	modelInfos: ClipProxyModelInfo[] = createFallbackModelInfos(),
): CustomProvider {
	const name = existing?.name || CLIPROXY_PROVIDER_ID;
	const baseUrl = normalizeBaseUrl(existing?.baseUrl || CLIPROXY_BASE_URL);
	const clipProxyModels = createClipProxyModels(name, baseUrl, modelInfos);
	const clipProxyModelIds = new Set(clipProxyModels.map((model) => model.id));
	const customModels =
		existing?.models?.filter(
			(model) =>
				!clipProxyModelIds.has(model.id) &&
				!LEGACY_CLIPROXY_MODEL_IDS.has(model.id) &&
				!isGeneratedClipProxyModel(model, name, baseUrl),
		) || [];

	return {
		id: existing?.id || CLIPROXY_PROVIDER_ID,
		name,
		type: "openai-responses",
		baseUrl,
		apiKey: existing?.apiKey || CLIPROXY_API_KEY,
		models: [...customModels, ...clipProxyModels],
	};
}
