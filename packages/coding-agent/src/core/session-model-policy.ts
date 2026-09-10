import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { SessionModelPolicy } from "./extensions/types.ts";

export function resolveSessionModelPolicy(
	policy: SessionModelPolicy,
	registry: { find(provider: string, id: string): Model<Api> | undefined },
) {
	if (!Array.isArray(policy.models) || policy.models.length === 0) {
		throw new Error("Model policy requires at least one model");
	}
	const models = policy.models.map((entry) => {
		const slash = entry.model.indexOf("/");
		const model = slash > 0 ? registry.find(entry.model.slice(0, slash), entry.model.slice(slash + 1)) : undefined;
		if (!model) throw new Error(`Unknown exact model in session policy: ${entry.model}`);
		if (entry.thinkingLevel !== undefined && !isValidThinkingLevel(entry.thinkingLevel)) {
			throw new Error(`Invalid thinking level in session policy: ${entry.thinkingLevel}`);
		}
		return { model, thinkingLevel: entry.thinkingLevel };
	});
	const selectors = models.map(
		({ model, thinkingLevel }) =>
			`${model.provider}/${model.id}${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}`,
	);
	return { models, selectors };
}
