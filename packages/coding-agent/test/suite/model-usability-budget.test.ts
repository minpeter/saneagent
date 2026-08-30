import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ModelUsabilityBudgetError,
	projectModelUsabilityBudget,
} from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("model usability budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rejects a selected model whose context cannot hold the assembled session budget", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 128_000, maxTokens: 4_000 },
				{ id: "low-context", contextWindow: 16_000, maxTokens: 4_000 },
			],
		});
		harnesses.push(harness);
		harness.agent.state.systemPrompt = "x";
		const lowContextModel = harness.getModel("low-context");
		if (!lowContextModel) throw new Error("missing low-context model fixture");

		// when
		const error = await harness.session.setModel(lowContextModel).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		// then
		expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
		if (!(error instanceof ModelUsabilityBudgetError)) throw new Error("expected model budget rejection");
		expect(error.message).toBe(
			'Model "faux/low-context" cannot start: context window 16000 tokens is 21464 tokens short of the 37464-token minimum (system prompt 1, active tool schemas 695, output reserve 4000, compaction reserve 16384, speculation lead 8192, safety margin 8192 [default]).',
		);
	});

	it("rejects an unusable initial model after SDK session assembly", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = { ...harness.getModel(), contextWindow: 16_000, maxTokens: 4_000 };

		// when / then
		await expect(
			createAgentSession({ cwd: harness.tempDir, agentDir: join(harness.tempDir, "sdk-agent"), model }),
		).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				model: `${model.provider}/${model.id}`,
				usable: false,
				contextWindow: 16_000,
			},
		});
	});

	it("accepts the exact minimum and rejects one token below it", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		const compaction = harness.settingsManager.getCompactionSettings();
		// when
		const atBoundary = projectModelUsabilityBudget({
			model: { ...model, contextWindow: 36_769, maxTokens: 4_000 },
			systemPrompt: "x",
			tools: [],
			compaction,
		});
		const belowBoundary = projectModelUsabilityBudget({
			model: { ...model, contextWindow: 36_768, maxTokens: 4_000 },
			systemPrompt: "x",
			tools: [],
			compaction,
		});
		// then
		expect(atBoundary).toMatchObject({ usable: true, requiredTokens: 36_769, shortfallTokens: 0 });
		expect(belowBoundary).toMatchObject({ usable: false, requiredTokens: 36_769, shortfallTokens: 1 });
	});

	it("preserves disabled compaction and speculation opt-outs", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = { ...harness.getModel(), contextWindow: 20_000, maxTokens: 4_000 };
		const settings = harness.settingsManager.getCompactionSettings();
		// when
		const disabled = projectModelUsabilityBudget({
			model,
			systemPrompt: "x",
			tools: [],
			compaction: { ...settings, enabled: false },
		});
		const speculationDisabled = projectModelUsabilityBudget({
			model,
			systemPrompt: "x",
			tools: [],
			compaction: {
				...settings,
				reserveTokens: 1_000,
				reserveScalingEnabled: false,
				speculativeEnabled: false,
			},
		});
		// then
		expect(disabled).toMatchObject({ compactionReserveTokens: 0, speculationLeadTokens: 0, usable: true });
		expect(speculationDisabled).toMatchObject({
			compactionReserveTokens: 1_000,
			speculationLeadTokens: 0,
			usable: true,
		});
	});

	it("selects a safety margin from model-family data", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		// when
		const projection = projectModelUsabilityBudget({
			model: { ...harness.getModel(), id: "vendor/claude-small", contextWindow: 64_000, maxTokens: 4_000 },
			systemPrompt: "x",
			tools: [],
			compaction: harness.settingsManager.getCompactionSettings(),
		});
		// then
		expect(projection).toMatchObject({ safetyMarginProfile: "anthropic", safetyMarginTokens: 16_384 });
	});
});
