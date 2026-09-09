import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { FooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { canonicalizeFallbackChains } from "../../src/core/retry-fallback/chains.ts";
import type { RetryFallbackController } from "../../src/core/retry-fallback/controller.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionAPI, ExtensionEvent, SessionModelPolicy } from "../../src/index.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const models = [
	{ id: "primary", reasoning: true },
	{ id: "fallback", reasoning: true },
	{ id: "outside", reasoning: true },
];
const policy: SessionModelPolicy = {
	models: [{ model: "faux/primary", thinkingLevel: "high" }, { model: "faux/fallback" }],
};

describe("configured model independent review regressions", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(options: HarnessOptions = {}) {
		const h = await createHarness({ models, ...options });
		harnesses.push(h);
		return h;
	}

	// Authoritative seeds: st_01a08493 policy.ts / policy.stdout.jsonl.
	it.each([true, false])(
		"singleton preserves global enable=%s inside and outside the declaration",
		async (enabled) => {
			const h = await setup({ settings: { retry: { modelFallback: enabled } } });
			await h.session.setModelPolicy({ models: [{ model: "faux/primary" }] });
			await h.session.followConfiguredModel();
			expect(h.session.getRetryFallbackSettings().modelFallback).toBe(enabled);
			await h.session.setSessionModel(h.models[2]!);
			expect(h.session.getRetryFallbackSettings().modelFallback).toBe(enabled);
			expect(h.settingsManager.getRetryFallbackSettings().modelFallback).toBe(enabled);
		},
	);

	it("no-model-fallback stays disabled even when settings are subsequently enabled", async () => {
		const h = await setup({
			extensionFactories: [() => {}],
			extensionFlagValues: new Map([["no-model-fallback", true]]),
		});
		h.settingsManager.setModelFallbackEnabled(true);
		await h.session.setModelPolicy(policy);
		await h.session.followConfiguredModel();
		expect(h.session.getRetryFallbackSettings().modelFallback).toBe(false);
		await h.session.setModelPolicy(undefined);
		expect(h.session.getRetryFallbackSettings().modelFallback).toBe(false);
	});

	it.each(["faux/primary", "primary"])(
		"configured chains beat %s thinking-qualified keys through real fallback",
		async (key) => {
			const h = await setup({
				settings: {
					retry: {
						maxRetries: 0,
						baseDelayMs: 0,
						fallbackChains: {
							[`${key}:high`]: ["faux/outside"],
							[`${key}:low`]: ["faux/outside"],
							"faux/outside:high": ["faux/primary"],
						},
					},
				},
			});
			h.session.modelRuntime.registerProvider("other", {
				api: h.models[0].api,
				apiKey: "local-key",
				baseUrl: "http://127.0.0.1:1",
				models: h.models,
			});
			const stored = h.settingsManager.getGlobalSettings();
			await h.session.setModelPolicy(policy);
			await h.session.followConfiguredModel();
			const chains = h.session.getRetryFallbackSettings().chains;
			expect(chains["faux/outside:high"]).toEqual(["faux/primary"]);
			h.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
				fauxAssistantMessage("ok"),
			]);
			await h.session.prompt("local fallback");
			expect(h.session.model?.id).toBe("fallback");
			expect(h.eventsOfType("retry_fallback_applied").map(({ to }) => to)).toEqual(["faux/fallback"]);
			expect(chains["faux/primary:high"]).toEqual(["faux/primary:high", "faux/fallback"]);
			expect(chains["faux/primary:low"]).toEqual(["faux/primary:high", "faux/fallback"]);
			const canonical = canonicalizeFallbackChains(chains, h.modelRegistry);
			expect(canonical["other/primary:high"]).toEqual(key === "primary" ? ["faux/outside"] : undefined);
			expect(h.settingsManager.getGlobalSettings()).toEqual(stored);
		},
	);

	it("does not overlay an unrelated literal-colon model ID as thinking tuning", async () => {
		const h = await setup({
			models: [...models, { id: "primary:high", reasoning: true }],
			settings: { retry: { fallbackChains: { "faux/primary:high": ["faux/outside"] } } },
		});
		await h.session.setModelPolicy({ models: [{ model: "faux/primary" }, { model: "faux/fallback" }] });
		const chains = h.session.getRetryFallbackSettings().chains;
		expect(chains["faux/primary"]).toEqual(["faux/primary", "faux/fallback"]);
		expect(chains["faux/primary:high"]).toEqual(["faux/outside"]);
		expect(canonicalizeFallbackChains(chains, h.modelRegistry)["faux/primary:high"]).toEqual(["faux/outside"]);
	});

	it.each([false, true])(
		"identical selectors silently rebind the CURRENT model (active fallback=%s)",
		async (fallback) => {
			const h = await setup({ settings: { retry: { maxRetries: 0, baseDelayMs: 0 } } });
			await h.session.setModelPolicy(policy);
			await h.session.followConfiguredModel();
			if (fallback) {
				h.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
					fauxAssistantMessage("ok"),
				]);
				await h.session.prompt("local fallback refresh");
			}
			const retry = Reflect.get(h.session, "_retryFallback") as RetryFallbackController;
			if (fallback) {
				expect(retry.activeState).toBeDefined();
				expect(retry.canTryFallback()).toBe(false);
			}
			const extensionEvents: ExtensionEvent[] = [];
			const runner = h.getExtensionRunner();
			const emit = runner.emit.bind(runner);
			vi.spyOn(runner, "emit").mockImplementation((event) => {
				extensionEvents.push(structuredClone(event));
				return emit(event);
			});
			const admission = vi.spyOn(runner, "emitModelSelect");
			const snapshot = () =>
				structuredClone({
					id: h.session.model?.id,
					thinking: h.session.thinkingLevel,
					selection: h.session.thinkingSelection,
					owned: h.session.isConfiguredModelOwned,
					source: h.session.modelSelectSource,
					prompt: h.session.systemPrompt,
					retry: retry.activeState,
					tried: [...Reflect.get(retry, "triedSelectors")],
					exhausted: retry.exhaustedChainKey,
					history: h.sessionManager.getEntries(),
					events: h.events,
					extensionEvents,
					defaults: h.settingsManager.getGlobalSettings(),
					revision: h.session.getMessageRevision(),
				});
			const before = snapshot();
			const old = h.session.model!;
			h.session.modelRuntime.registerProvider("faux", {
				api: old.api,
				apiKey: "faux-key",
				baseUrl: "http://127.0.0.1:2/refreshed",
				models: h.models.map((model) => ({
					...model,
					baseUrl: "http://127.0.0.1:2/refreshed",
					contextWindow: model.contextWindow * 2,
				})),
			});
			// Runtime providers may materialize a new object per lookup. Verify that the
			// active object is one actually returned by the CURRENT registry, not a clone.
			const lookup = vi.spyOn(h.session.modelRuntime, "getModel");
			await h.session.setModelPolicy(policy);
			expect(snapshot()).toEqual(before);
			expect(lookup.mock.results.map((result) => result.value)).toContain(h.session.model);
			expect(h.session.model).toEqual(h.session.modelRuntime.getModel(old.provider, old.id));
			expect(h.session.model).not.toBe(old);
			expect(h.session.model?.baseUrl).toBe("http://127.0.0.1:2/refreshed");
			expect(admission).not.toHaveBeenCalled();
		},
	);

	it.each(["setModel", "setSessionModel"] as const)(
		"extension %s forwards deliberate intent through loader/runtime",
		async (method) => {
			let api!: ExtensionAPI;
			const h = await setup({
				extensionFactories: [
					(pi) => {
						api = pi;
					},
				],
			});
			await h.session.setModelPolicy(policy);
			for (const deliberate of [undefined, false, true]) {
				await h.session.followConfiguredModel();
				expect(await api[method](h.models[2]!, deliberate === undefined ? undefined : { deliberate })).toBe(true);
				expect(h.session.isConfiguredModelOwned).toBe(deliberate !== true);
				expect(h.sessionManager.getBranch().findLast((entry) => entry.type === "model_change")).toMatchObject({
					selectionIntent: deliberate ? "manual" : "programmatic",
				});
			}
		},
	);

	it("removing the declaration clears configured provenance in existing and new footers", async () => {
		initTheme("dark");
		const h = await setup();
		const data = new FooterDataProvider(h.tempDir);
		try {
			const footer = new FooterComponent(h.session, data);
			const stop = h.session.subscribe((event) => {
				if (event.type === "model_changed") footer.setModelSelectSource(event.source);
			});
			await h.session.setModelPolicy(policy);
			await h.session.followConfiguredModel();
			const render = (component: FooterComponent) => component.render(180).map(stripVTControlCharacters).join("\n");
			expect(render(footer)).toContain("(configured)");
			const history = h.sessionManager.getEntries();
			await h.session.setModelPolicy(undefined);
			expect(h.session.hasConfiguredModel).toBe(false);
			expect(h.session.isConfiguredModelOwned).toBe(false);
			expect(h.session.modelSelectSource).not.toBe("configured");
			expect(render(footer)).not.toContain("(configured)");
			expect(render(new FooterComponent(h.session, data))).not.toContain("(configured)");
			expect(h.sessionManager.getEntries()).toEqual(history);
			stop();
		} finally {
			data.dispose();
		}
	});

	async function launch(
		h: Harness,
		options: {
			explicit?: boolean;
			configured?: boolean;
			manager?: SessionManager;
			defaultId?: string;
			enabled?: boolean;
		} = {},
	) {
		let starts = 0;
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) =>
					pi.on("session_start", async (_event, ctx) => {
						starts++;
						if (options.configured !== false)
							await ctx.sessionSettings.setModelPolicy?.({
								models: [{ model: "faux/viable", thinkingLevel: "high" }],
							});
					}),
			],
			h.tempDir,
		);
		const settings = SettingsManager.inMemory({
			defaultProvider: "faux",
			defaultModel: options.defaultId ?? "tiny",
			...(options.enabled ? { enabledModels: ["faux/tiny", "faux/viable"] } : {}),
		});
		const result = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			authStorage: h.authStorage,
			settingsManager: settings,
			sessionManager: options.manager ?? SessionManager.inMemory(h.tempDir),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			...(options.explicit ? { model: h.models[0] } : {}),
		});
		sessions.push(result.session);
		return { session: result.session, settings, starts: () => starts };
	}
	const startupModels = [
		{ id: "tiny", contextWindow: 1000, maxTokens: 128 },
		{ id: "viable", contextWindow: 100000, maxTokens: 4000 },
	];
	it("implicit unusable default allows configured selection before initial admission", async () => {
		const h = await setup({ models: startupModels });
		const { session, starts, settings } = await launch(h);
		await session.bindExtensions({ shutdownHandler() {} });
		expect(starts()).toBe(1);
		expect(session.model?.id).toBe("viable");
		expect(session.thinkingLevel).toBe("off");
		expect(session.isConfiguredModelOwned).toBe(true);
		expect(settings.getDefaultModel()).toBe("tiny");
	});
	it("explicit unusable launch still rejects before session_start", async () => {
		const h = await setup({ models: startupModels });
		await expect(launch(h, { explicit: true })).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
	});
	it("manual unusable selection rejects after configured startup without changing intent or history", async () => {
		const h = await setup({ models: startupModels });
		const { session } = await launch(h);
		await session.bindExtensions({ shutdownHandler() {} });
		const history = session.sessionManager.getEntries();
		await expect(session.setSessionModel(h.models[0])).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(session.model?.id).toBe("viable");
		expect(session.isConfiguredModelOwned).toBe(true);
		expect(session.sessionManager.getEntries()).toEqual(history);
	});
	it("restored manual thinking is effectively clamped without rewriting the saved selection", async () => {
		const h = await setup({ models: [{ id: "tiny" }, { id: "viable" }] });
		const manager = SessionManager.inMemory(h.tempDir);
		manager.appendModelChange("faux", "tiny", undefined, undefined, undefined, "manual");
		manager.appendThinkingLevelChange("high", { level: "high", source: "explicit" });
		const before = manager.getEntries();
		const { session } = await launch(h, { manager });
		await session.bindExtensions({ shutdownHandler() {} });
		expect(session.model?.id).toBe("tiny");
		expect(session.thinkingLevel).toBe("off");
		expect(session.thinkingSelection).toEqual({ level: "off", source: "explicit" });
		expect(session.isConfiguredModelOwned).toBe(false);
		expect(manager.getEntries()).toEqual(before);
	});
	it("an unreplaced implicit unusable default rejects at binding and before an unbound prompt", async () => {
		const h = await setup({ models: startupModels });
		const { session } = await launch(h, { configured: false });
		await expect(session.bindExtensions({ shutdownHandler() {} })).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		const unbound = await launch(h, { configured: false });
		await expect(unbound.session.prompt("no provider call")).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
	});
	it.each([false, true])(
		"explicit viable launch records manual intent in fresh/empty configured session (empty=%s)",
		async (empty) => {
			const h = await setup({ models: [{ id: "tiny" }, { id: "viable" }] });
			const manager = SessionManager.inMemory(h.tempDir);
			if (empty) manager.appendModelChange("faux", "viable", undefined, undefined, undefined, "configured");
			const { session } = await launch(h, { explicit: true, manager });
			await session.bindExtensions({ shutdownHandler() {} });
			expect(session.model?.id).toBe("tiny");
			expect(session.isConfiguredModelOwned).toBe(false);
			expect(manager.getBranch().findLast((entry) => entry.type === "model_change")).toMatchObject({
				modelId: "tiny",
				selectionIntent: "manual",
			});
		},
	);
	it("no-policy settings narrowing retains a saved default that is not the first enabled model", async () => {
		const h = await setup({ models: [{ id: "tiny" }, { id: "viable" }] });
		const { session } = await launch(h, { configured: false, defaultId: "viable", enabled: true });
		await session.bindExtensions({ shutdownHandler() {} });
		expect(session.model?.id).toBe("viable");
		expect(session.isConfiguredModelOwned).toBe(false);
	});
});
