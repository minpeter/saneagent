import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSessionFromServices } from "../../src/core/agent-session-services.ts";
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

	// "Identical" is the whole selector, tuning included. A same-model declaration carrying a
	// different thinking level is a real change and must apply, clearing the fallback window -
	// otherwise the refresh short-circuit would silently swallow a retune.
	it("a differing declared thinking level is not an identical-selector refresh", async () => {
		const h = await setup({ settings: { retry: { maxRetries: 0, baseDelayMs: 0 } } });
		await h.session.setModelPolicy(policy);
		await h.session.followConfiguredModel();
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
			fauxAssistantMessage("ok"),
		]);
		await h.session.prompt("local fallback");
		const retry = Reflect.get(h.session, "_retryFallback") as RetryFallbackController;
		expect(h.session.model?.id).toBe("fallback");
		expect(retry.activeState).toBeDefined();
		await h.session.setModelPolicy({
			models: [{ model: "faux/primary", thinkingLevel: "low" }, { model: "faux/fallback" }],
		});
		expect(h.session.model?.id).toBe("primary");
		expect(h.session.thinkingLevel).toBe("low");
		expect(h.session.modelSelectSource).toBe("configured");
		expect(retry.activeState).toBeUndefined();
	});

	// A manual override owns the slot. Re-declaring the same selectors is a refresh, not a
	// selection, so it must not quietly pull the user back onto the declared model.
	it("an identical-selector refresh does not reclaim the slot from a manual override", async () => {
		const h = await setup({ settings: { retry: { maxRetries: 0, baseDelayMs: 0 } } });
		await h.session.setModelPolicy(policy);
		await h.session.setSessionModel(h.models[2]!);
		const before = {
			model: h.session.model?.id,
			owned: h.session.isConfiguredModelOwned,
			source: h.session.modelSelectSource,
			history: h.sessionManager.getEntries(),
			changes: h.eventsOfType("model_changed").length,
		};
		await h.session.setModelPolicy(policy);
		expect({
			model: h.session.model?.id,
			owned: h.session.isConfiguredModelOwned,
			source: h.session.modelSelectSource,
			history: h.sessionManager.getEntries(),
			changes: h.eventsOfType("model_changed").length,
		}).toEqual(before);
		expect(before.model).toBe("outside");
		expect(before.owned).toBe(false);
	});

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
			configured?: boolean | string;
			manager?: SessionManager;
			defaultId?: string;
			enabled?: boolean | string[];
			/** Explicit SDK/CLI narrowing, as `--models` produces it. */
			scope?: string[];
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
								models: [
									{
										model: typeof options.configured === "string" ? options.configured : "faux/viable",
										thinkingLevel: "high",
									},
								],
							});
					}),
			],
			h.tempDir,
		);
		const settings = SettingsManager.inMemory({
			defaultProvider: "faux",
			defaultModel: options.defaultId ?? "tiny",
			...(Array.isArray(options.enabled)
				? { enabledModels: options.enabled }
				: options.enabled
					? { enabledModels: ["faux/tiny", "faux/viable"] }
					: {}),
		});
		const result = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			authStorage: h.authStorage,
			settingsManager: settings,
			sessionManager: options.manager ?? SessionManager.inMemory(h.tempDir),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			...(options.scope
				? {
						scopedModels: options.scope.map((id) => {
							const model = h.getModel(id);
							if (!model) throw new Error(`Missing scoped fixture ${id}`);
							return { model };
						}),
					}
				: {}),
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
	// The saved default only wins while it stays inside the narrowed scope. Out of scope it must
	// yield to scope order rather than resurrect a model the narrowing just excluded.
	it("settings narrowing falls back to scope order when the saved default is out of scope", async () => {
		const h = await setup({ models: startupModels });
		const { session } = await launch(h, {
			configured: false,
			defaultId: "tiny",
			enabled: ["faux/viable"],
		});
		await session.bindExtensions({ shutdownHandler() {} });
		expect(session.model?.id).toBe("viable");
		expect(session.isConfiguredModelOwned).toBe(false);
	});
	// A declaration relaxes admission ordering, not the budget itself: naming a model that cannot
	// admit the session must still reject rather than start an unusable session.
	it("a declared primary that is itself unusable still rejects at binding", async () => {
		const h = await setup({ models: startupModels });
		const { session } = await launch(h, { configured: "faux/tiny" });
		await expect(session.bindExtensions({ shutdownHandler() {} })).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
	});
	// A declared thinking level is session-scoped: it clamps to what the model supports and stays
	// ephemeral, so it never persists as a durable user selection.
	it.each([
		["non-reasoning", false, "off"],
		["reasoning", true, "high"],
	] as const)(
		"a declared thinking level clamps on a %s model without durable provenance",
		async (_l, reasoning, expected) => {
			const h = await setup({
				models: [{ id: "tiny" }, { id: "viable", reasoning, contextWindow: 100000, maxTokens: 4000 }],
			});
			const { session, settings } = await launch(h);
			await session.bindExtensions({ shutdownHandler() {} });
			expect(session.model?.id).toBe("viable");
			expect(session.thinkingLevel).toBe(expected);
			expect(session.thinkingSelection).toBeUndefined();
			expect(settings.getDefaultThinkingLevel()).toBeUndefined();
		},
	);

	// A resumed session whose last selection was configured is still the declaration's to make.
	// Admitting the restored model eagerly rejected the launch before session_start could hand
	// the slot to a viable declared model, so a catalog shrink locked the user out of the session.
	it("a resumed configured session admits the declared primary instead of the unusable restored model", async () => {
		const h = await setup({ models: startupModels });
		const manager = SessionManager.inMemory(h.tempDir);
		manager.appendModelChange("faux", "tiny", undefined, undefined, undefined, "configured");
		manager.appendMessage({ role: "user", content: "earlier turn", timestamp: 1 });
		const { session } = await launch(h, { manager });
		await session.bindExtensions({ shutdownHandler() {} });
		expect(session.model?.id).toBe("viable");
		expect(session.isConfiguredModelOwned).toBe(true);
	});

	// Deferral relaxes ordering, not the budget: with nothing viable declared the resumed
	// session must still reject rather than run on a model that cannot hold its transcript.
	it("a resumed configured session with no viable declaration still rejects", async () => {
		const h = await setup({ models: startupModels });
		const manager = SessionManager.inMemory(h.tempDir);
		manager.appendModelChange("faux", "tiny", undefined, undefined, undefined, "configured");
		manager.appendMessage({ role: "user", content: "earlier turn", timestamp: 1 });
		const { session } = await launch(h, { manager, configured: false });
		await expect(session.bindExtensions({ shutdownHandler() {} })).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
	});

	// Narrowing chooses which models are reachable, not which one starts. The CLI already
	// preferred a saved default that survived `--models`; a direct SDK scope took scope order
	// instead, so the same configuration started on different models through the two surfaces.
	it("an explicit SDK scope retains a saved default that is not the first scoped model", async () => {
		const h = await setup({ models: [{ id: "tiny" }, { id: "viable" }] });
		const { session } = await launch(h, { configured: false, defaultId: "viable", scope: ["tiny", "viable"] });
		await session.bindExtensions({ shutdownHandler() {} });
		expect(session.model?.id).toBe("viable");
		expect(session.isConfiguredModelOwned).toBe(false);
	});

	// A scope-derived startup pick is a narrowing default, not a chosen model. Recording it as
	// durable manual intent disarmed the declaration in every later resume, long after the
	// narrowing flag was gone.
	it("a scoped startup selection is not durable manual intent", async () => {
		const h = await setup({ models: [{ id: "tiny" }, { id: "viable" }] });
		const manager = SessionManager.inMemory(h.tempDir);
		const scoped = h.getModel("tiny");
		if (!scoped) throw new Error("Missing scoped fixture");
		const extensionsResult = await createTestExtensionsResult([], h.tempDir);
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			authStorage: h.authStorage,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "tiny" }),
			sessionManager: manager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			model: scoped,
			initialModelProvenance: "scoped",
			scopedModels: [{ model: scoped }],
		});
		sessions.push(session);
		const startupEntry = manager.getBranch().findLast((entry) => entry.type === "model_change");
		expect(
			startupEntry?.type === "model_change" ? [startupEntry.modelId, startupEntry.selectionIntent] : undefined,
		).toEqual(["tiny", undefined]);
		// Reopening without the narrowing hands the slot back to a declaration.
		const reopened = await launch(h, { manager });
		await reopened.session.bindExtensions({ shutdownHandler() {} });
		expect(reopened.session.model?.id).toBe("viable");
		expect(reopened.session.isConfiguredModelOwned).toBe(true);
	});

	// Real-CLI QA caught this: `main.ts` computed `initialModelProvenance` but the services
	// adapter dropped it, so every CLI launch reached the SDK with provenance undefined and a
	// `--models` narrowing default was still written as durable manual intent. The scoped-intent
	// rule is only observable end to end if this option survives the adapter.
	it("forwards initialModelProvenance through the services adapter", async () => {
		const h = await setup({ models: [{ id: "tiny" }, { id: "viable" }] });
		const manager = SessionManager.inMemory(h.tempDir);
		const scoped = h.getModel("tiny");
		if (!scoped) throw new Error("Missing scoped fixture");
		const settingsManager = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "tiny" });
		const resourceLoader = createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult([], h.tempDir),
		});
		const { session } = await createAgentSessionFromServices({
			services: {
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.session.modelRuntime,
				modelRegistry: h.session.modelRegistry,
				authStorage: h.authStorage,
				settingsManager,
				resourceLoader,
			} as Parameters<typeof createAgentSessionFromServices>[0]["services"],
			sessionManager: manager,
			model: scoped,
			initialModelProvenance: "scoped",
			scopedModels: [{ model: scoped }],
		});
		sessions.push(session);
		const entry = manager.getBranch().findLast((candidate) => candidate.type === "model_change");
		expect(entry?.type === "model_change" ? [entry.modelId, entry.selectionIntent] : undefined).toEqual([
			"tiny",
			undefined,
		]);
	});

	// An identical-selector re-declaration rebinds the active model to the refreshed catalog
	// object. When that object no longer supports the level the session is running, the level
	// has to come down with it - including when a fallback, not the primary, is active.
	it.each(["primary", "fallback"] as const)(
		"an identical-selector refresh clamps the thinking level of the active %s model",
		async (active) => {
			const h = await setup({ settings: { retry: { maxRetries: 0, baseDelayMs: 0 } } });
			const declaration: SessionModelPolicy = {
				models: [
					{ model: "faux/primary", thinkingLevel: "high" },
					{ model: "faux/fallback", thinkingLevel: "high" },
				],
			};
			await h.session.setModelPolicy(declaration);
			await h.session.followConfiguredModel();
			if (active === "fallback") {
				h.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
					fauxAssistantMessage("ok"),
				]);
				await h.session.prompt("drive a fallback");
			}
			expect(h.session.model?.id).toBe(active);
			expect(h.session.thinkingLevel).toBe("high");
			const levels = h.eventsOfType("thinking_level_changed").length;
			h.session.modelRuntime.registerProvider("faux", {
				baseUrl: h.models[0].baseUrl,
				apiKey: "faux-key",
				api: h.models[0].api,
				models: h.models.map((model) => ({ ...model, reasoning: model.id !== active })),
			});
			await h.session.setModelPolicy(declaration);
			expect(h.session.model?.id).toBe(active);
			expect(h.session.model?.reasoning).toBe(false);
			expect(h.session.thinkingLevel).toBe("off");
			expect(
				h
					.eventsOfType("thinking_level_changed")
					.map((event) => event.level)
					.slice(levels),
			).toEqual(["off"]);
			expect(h.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
		},
	);
});
