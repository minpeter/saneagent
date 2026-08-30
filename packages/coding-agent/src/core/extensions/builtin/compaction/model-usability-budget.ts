import { type Api, estimateContextTokens, type Model, type Tool } from "@earendil-works/pi-ai";
import type { CompactionPreparation } from "../../../compaction/index.ts";
import { getPromptContextWindow } from "./extension-wiring.ts";
import { resolveCompactionGeometry } from "./orchestration.ts";

interface ModelSafetyMarginProfile {
	readonly id: string;
	readonly tokens: number;
	readonly providers?: readonly string[];
	readonly familyMarkers?: readonly string[];
}

/** Measured conversation runway by shipped prompt family, rounded up to a 4K token boundary. */
const MODEL_SAFETY_MARGIN_PROFILES: readonly ModelSafetyMarginProfile[] = [
	{ id: "anthropic", tokens: 16_384, providers: ["anthropic"], familyMarkers: ["claude"] },
	{ id: "openai-reasoning", tokens: 16_384, providers: ["openai"], familyMarkers: ["gpt-5", "o1", "o3", "o4"] },
	{ id: "google", tokens: 12_288, providers: ["google"], familyMarkers: ["gemini"] },
	{ id: "deepseek", tokens: 12_288, providers: ["deepseek"], familyMarkers: ["deepseek"] },
	{ id: "default", tokens: 8_192 },
];

export interface ModelUsabilityBudgetProjection {
	readonly model: string;
	readonly contextWindow: number;
	readonly systemPromptTokens: number;
	readonly activeToolSchemaTokens: number;
	readonly outputReserveTokens: number;
	readonly compactionReserveTokens: number;
	readonly speculationLeadTokens: number;
	readonly safetyMarginTokens: number;
	readonly safetyMarginProfile: string;
	readonly requiredTokens: number;
	readonly shortfallTokens: number;
	readonly usable: boolean;
}

export interface ModelUsabilityBudgetInput<TApi extends Api> {
	readonly model: Model<TApi>;
	readonly systemPrompt: string;
	readonly tools: readonly Tool[];
	readonly compaction: CompactionPreparation["settings"];
}

function matchesFamilyMarker(modelId: string, marker: string): boolean {
	const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[/.:_-])${escapedMarker}(?=$|[^a-z0-9])`).test(modelId.toLowerCase());
}

function resolveSafetyMarginProfile<TApi extends Api>(model: Model<TApi>): ModelSafetyMarginProfile {
	return (
		MODEL_SAFETY_MARGIN_PROFILES.find(
			(profile) =>
				profile.id !== "default" &&
				(profile.providers?.includes(model.provider) === true ||
					profile.familyMarkers?.some((marker) => matchesFamilyMarker(model.id, marker)) === true),
		) ?? MODEL_SAFETY_MARGIN_PROFILES[MODEL_SAFETY_MARGIN_PROFILES.length - 1]
	);
}

export function projectModelUsabilityBudget<TApi extends Api>(
	input: ModelUsabilityBudgetInput<TApi>,
): ModelUsabilityBudgetProjection {
	const systemPromptTokens = estimateContextTokens({
		systemPrompt: input.systemPrompt,
		messages: [],
		tools: [],
	}).tokens;
	const promptAndToolsTokens = estimateContextTokens({
		systemPrompt: input.systemPrompt,
		messages: [],
		tools: [...input.tools],
	}).tokens;
	const activeToolSchemaTokens = promptAndToolsTokens - systemPromptTokens;
	const outputReserveTokens =
		input.model.contextWindow - getPromptContextWindow(input.model.contextWindow, input.model.maxTokens);
	const geometry = resolveCompactionGeometry({ contextWindow: input.model.contextWindow, settings: input.compaction });
	const compactionReserveTokens = input.compaction.enabled ? geometry.reserveTokens : 0;
	const speculationLeadTokens =
		input.compaction.enabled && input.compaction.speculativeEnabled !== false ? geometry.leadTokens : 0;
	const safetyMargin = resolveSafetyMarginProfile(input.model);
	const requiredTokens =
		systemPromptTokens +
		activeToolSchemaTokens +
		outputReserveTokens +
		compactionReserveTokens +
		speculationLeadTokens +
		safetyMargin.tokens;
	const shortfallTokens = Math.max(0, requiredTokens - input.model.contextWindow);

	return {
		model: `${input.model.provider}/${input.model.id}`,
		contextWindow: input.model.contextWindow,
		systemPromptTokens,
		activeToolSchemaTokens,
		outputReserveTokens,
		compactionReserveTokens,
		speculationLeadTokens,
		safetyMarginTokens: safetyMargin.tokens,
		safetyMarginProfile: safetyMargin.id,
		requiredTokens,
		shortfallTokens,
		usable: shortfallTokens === 0,
	};
}

export class ModelUsabilityBudgetError extends Error {
	readonly projection: ModelUsabilityBudgetProjection;

	constructor(projection: ModelUsabilityBudgetProjection) {
		super(
			`Model "${projection.model}" cannot start: context window ${projection.contextWindow} tokens is ${projection.shortfallTokens} tokens short of the ${projection.requiredTokens}-token minimum (system prompt ${projection.systemPromptTokens}, active tool schemas ${projection.activeToolSchemaTokens}, output reserve ${projection.outputReserveTokens}, compaction reserve ${projection.compactionReserveTokens}, speculation lead ${projection.speculationLeadTokens}, safety margin ${projection.safetyMarginTokens} [${projection.safetyMarginProfile}]).`,
		);
		this.name = "ModelUsabilityBudgetError";
		this.projection = projection;
	}
}
