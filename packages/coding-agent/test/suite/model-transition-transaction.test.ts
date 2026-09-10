import { isDeepStrictEqual } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import type { ExtensionAPI, ExtensionEvent } from "../../src/core/extensions/types.ts";
import type { RetryFallbackController } from "../../src/core/retry-fallback/controller.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), 8_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function outcome<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ status: "fulfilled" as const, value }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	);
}

function policy(id: string) {
	return { models: [{ model: `faux/${id}`, thinkingLevel: "high" as const }] };
}

const models = [
	{ id: "primary", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
	{ id: "older", reasoning: true, contextWindow: 99_000, maxTokens: 4_000 },
	{ id: "newer", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
];

// Observe the real runner without replacing any handler or swallowing its errors. Admission
// model_select invocations are tracked separately: they are hooks, not acceptance notifications.
function observeExtensions(harness: Harness, events: ExtensionEvent[] = []) {
	const runner = harness.getExtensionRunner();
	const emit = runner.emit.bind(runner);
	vi.spyOn(runner, "emit").mockImplementation((event) => {
		events.push(structuredClone(event));
		return emit(event);
	});
	return events;
}

function snapshot(harness: Harness, extensionEvents: ExtensionEvent[]) {
	const session = harness.session;
	const retry = Reflect.get(session, "_retryFallback") as RetryFallbackController;
	return structuredClone({
		model: session.model,
		thinking: session.thinkingLevel,
		selection: session.thinkingSelection,
		reasoningBaseline: session.agent.state.reasoningBaseline,
		prompt: session.systemPrompt,
		tier: session.serviceTier,
		effectiveTier: session.effectiveServiceTier,
		fast: session.isFastModeActive(),
		sessionFastMode: Reflect.get(session, "_sessionFastMode") as boolean,
		abortServerSideFallback: session.agent.abortServerSideFallback,
		owned: session.isConfiguredModelOwned,
		source: session.modelSelectSource,
		policy: session.getRetryFallbackSettings(),
		history: harness.sessionManager.getEntries(),
		branch: harness.sessionManager.getBranch(),
		messages: session.messages,
		defaults: harness.settingsManager.getGlobalSettings(),
		projectDefaults: harness.settingsManager.getProjectSettings(),
		retry: {
			state: retry.activeState,
			tried: [...(Reflect.get(retry, "triedSelectors") as Set<string>)],
			exhausted: retry.exhaustedChainKey,
		},
		events: harness.events,
		extensionEvents,
		revision: session.getMessageRevision(),
	});
}

function expectUnchanged(actual: ReturnType<typeof snapshot>, expected: ReturnType<typeof snapshot>) {
	// Report every mismatching field without dumping the deliberately oversized hook prompt.
	const keys = Object.keys(expected) as Array<keyof typeof expected>;
	expect(Object.fromEntries(keys.map((key) => [key, isDeepStrictEqual(actual[key], expected[key])]))).toEqual(
		Object.fromEntries(keys.map((key) => [key, true])),
	);
}

function selectedModelIds(events: AgentSessionEvent[]) {
	return events.flatMap((event) => (event.type === "model_changed" ? [event.model.id] : []));
}

describe("transactional, generation-aware model transitions", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	// Seeds: st_01a08493 overlap.ts, policy/manual/cycle x ordinary/oversized late hook result.
	for (const operation of ["configured", "manual", "cycle"] as const) {
		for (const rejectOlder of [false, true]) {
			it(`rejects late ${operation} ${rejectOlder ? "oversized" : "successful"} admission without changing the accepted newer selection`, async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const harness = await createHarness({
					models,
					extensionFactories: [
						(pi) => {
							pi.on("model_select", async (event) => {
								if (event.model.id === "older") {
									entered.resolve();
									await release.promise;
									return { systemPrompt: rejectOlder ? "huge ".repeat(100_000) : "OLD" };
								}
								if (event.model.id === "newer") return { systemPrompt: "NEW" };
							});
						},
					],
				});
				harnesses.push(harness);
				const extensionEvents = observeExtensions(harness);
				await harness.session.setModelPolicy(policy("primary"));
				await harness.session.followConfiguredModel();
				harness.session.setFavoriteModels(harness.models.map((model) => ({ model })));
				const start = harness.events.length;
				const older = outcome<unknown>(
					operation === "configured"
						? harness.session.setModelPolicy(policy("older"))
						: operation === "manual"
							? harness.session.setModel(harness.models[1]!)
							: harness.session.cycleModel(),
				);
				try {
					await bounded(entered.promise, "older model_select");
					await bounded(harness.session.setModel(harness.models[2]!), "newer selection");
					expect(harness.session.model?.id).toBe("newer");
					expect(harness.session.isConfiguredModelOwned).toBe(false);
					expect(harness.session.systemPrompt).toBe("NEW");
					const acceptedNewer = snapshot(harness, extensionEvents);
					release.resolve();
					const result = await bounded(older, "older completion");
					expectUnchanged(snapshot(harness, extensionEvents), acceptedNewer);
					expect(result.status).toBe("rejected");
					expect(selectedModelIds(harness.events.slice(start))).toEqual(["newer"]);
				} finally {
					release.resolve();
					await bounded(older, "older cleanup");
				}
			});
		}
	}

	it("rejects in-flight and extracted facade calls after direct runner invalidation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						if (event.model.id !== "older") return;
						entered.resolve();
						await release.promise;
						return { systemPrompt: "OLD" };
					});
				},
			],
		});
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		await harness.session.setModelPolicy(policy("primary"));
		await harness.session.followConfiguredModel();
		const runner = harness.getExtensionRunner();
		const facade = runner.createContext().sessionSettings;
		const extracted = facade.setModelPolicy;
		if (!extracted) throw new Error("Missing model policy API");
		const before = snapshot(harness, extensionEvents);
		const pending = outcome(extracted(policy("older")));
		try {
			await bounded(entered.promise, "facade model_select");
			runner.invalidate("probe invalidated generation");
			expect(() => facade.setModelPolicy).toThrow();
			expect(() => extracted(undefined)).toThrow();
			release.resolve();
			const result = await bounded(pending, "facade completion");
			expectUnchanged(snapshot(harness, extensionEvents), before);
			expect(result.status).toBe("rejected");
		} finally {
			release.resolve();
			await bounded(pending, "facade cleanup");
		}
	});

	// Seed: st_01a08493 generation-cycle.ts. This replaces the extension runtime through
	// actual AgentSession.reload(), not a manually changed field or mocked reload method.
	it.each([false, true])("retires an in-flight facade across real reload (oversized=%s)", async (oversized) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let wanted = "primary";
		const factory = (pi: ExtensionAPI) => {
			pi.on("model_select", async (event) => {
				if (event.model.id === "older") {
					entered.resolve();
					await release.promise;
					return { systemPrompt: oversized ? "huge ".repeat(100_000) : "OLD" };
				}
				if (event.model.id === "newer") return { systemPrompt: "NEW" };
			});
			pi.on("session_start", async (_event, context) => {
				if (!context.sessionSettings.setModelPolicy) throw new Error("Missing model policy API");
				await context.sessionSettings.setModelPolicy(policy(wanted));
			});
		};
		let extensionsResult = await createTestExtensionsResult([factory]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getExtensions: () => extensionsResult,
			reload: async () => {
				extensionsResult = await createTestExtensionsResult([factory]);
			},
		};
		const harness = await createHarness({ models, resourceLoader });
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		await harness.session.bindExtensions({ shutdownHandler() {} });
		await harness.session.followConfiguredModel();
		const oldRunner = harness.getExtensionRunner();
		const extracted = oldRunner.createContext().sessionSettings.setModelPolicy;
		if (!extracted) throw new Error("Missing model policy API");
		const pending = outcome(extracted(policy("older")));
		try {
			await bounded(entered.promise, "old generation model_select");
			wanted = "newer";
			await bounded(
				harness.session.reload({
					beforeSessionStart: () => {
						observeExtensions(harness, extensionEvents);
					},
				}),
				"real reload",
			);
			expect(oldRunner.isActive).toBe(false);
			expect(() => extracted(undefined)).toThrow();
			expect(harness.session.model?.id).toBe("newer");
			expect(harness.session.systemPrompt).toBe("NEW");
			const before = snapshot(harness, extensionEvents);
			release.resolve();
			const result = await bounded(pending, "old generation completion");
			expectUnchanged(snapshot(harness, extensionEvents), before);
			expect(result.status).toBe("rejected");
		} finally {
			release.resolve();
			await bounded(pending, "reload cleanup");
		}
	});

	it("does not serialize a hook that awaits a newer explicit selection or resume its later handlers", async () => {
		const nestedSelected = Promise.withResolvers<void>();
		const laterHandlers: string[] = [];
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event, context) => {
						if (event.model.id === "older") {
							const newer = context.modelRegistry.find("faux", "newer");
							if (!newer) throw new Error("Missing newer model");
							await harness.session.setModel(newer);
							nestedSelected.resolve();
							return { systemPrompt: "OLD" };
						}
						if (event.model.id === "newer") return { systemPrompt: "NEW" };
					});
					pi.on("model_select", (event) => {
						laterHandlers.push(event.model.id);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setModelPolicy(policy("primary"));
		await harness.session.followConfiguredModel();
		const pending = outcome(harness.session.setModel(harness.models[1]!));
		await bounded(nestedSelected.promise, "nested selection");
		expect((await bounded(pending, "reentrant admission")).status).toBe("rejected");
		expect(harness.session.model?.id).toBe("newer");
		expect(harness.session.systemPrompt).toBe("NEW");
		expect(harness.settingsManager.getDefaultModel()).toBe("newer");
		expect(laterHandlers).toEqual(["newer"]);
	});

	it("orders admission before asynchronous auth so slow old auth cannot overtake the latest choice", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({ models });
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		const checkAuth = harness.session.modelRuntime.checkAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementationOnce(async (provider, options) => {
			entered.resolve();
			await release.promise;
			return checkAuth(provider, options);
		});
		const older = outcome(harness.session.setModel(harness.models[1]!));
		try {
			await bounded(entered.promise, "older auth");
			await harness.session.setModel(harness.models[2]!);
			const newer = snapshot(harness, extensionEvents);
			release.resolve();
			expect((await bounded(older, "older auth completion")).status).toBe("rejected");
			expectUnchanged(snapshot(harness, extensionEvents), newer);
		} finally {
			release.resolve();
			await bounded(older, "auth cleanup");
		}
	});

	it("does not resurrect either provisional model when both overlapping admissions fail", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) =>
					pi.on("model_select", async (event) => {
						if (event.model.id === "older") {
							entered.resolve();
							await release.promise;
						}
						return { systemPrompt: "huge ".repeat(100_000) };
					}),
			],
		});
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		const before = snapshot(harness, extensionEvents);
		const older = outcome(harness.session.setModel(harness.models[1]!));
		try {
			await bounded(entered.promise, "older candidate");
			await expect(harness.session.setModel(harness.models[2]!)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
			release.resolve();
			expect((await bounded(older, "two rejections")).status).toBe("rejected");
			expectUnchanged(snapshot(harness, extensionEvents), before);
		} finally {
			release.resolve();
			await bounded(older, "two rejections cleanup");
		}
	});

	it("keeps committed cycle metadata and legitimate prompt notifications together even while a notification awaits", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const received: ExtensionEvent[] = [];
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => ({ systemPrompt: event.model.id === "older" ? "OLD" : "NEW" }));
					pi.on("system_prompt_change", async (event) => {
						received.push(event);
						if (event.model.id !== "older") return;
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		harness.session.setFavoriteModels([
			{ model: harness.models[0] },
			{
				model: harness.models[1]!,
				thinkingLevel: "low",
				serviceTier: "priority",
				thinkingSelection: { level: "low", source: "legacy-variant", legacyVariantId: "older-low" },
			},
		]);
		const cycle = outcome(harness.session.cycleModel());
		try {
			await bounded(entered.promise, "accepted prompt notification");
			expect(harness.settingsManager.getDefaultModel()).toBe("older");
			expect(harness.session.thinkingSelection).toEqual({
				level: "low",
				source: "legacy-variant",
				legacyVariantId: "older-low",
			});
			expect(harness.session.serviceTier).toBe("priority");
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(1);
			await harness.session.setModel(harness.models[2]!);
			const newer = snapshot(harness, extensionEvents);
			release.resolve();
			const result = await bounded(cycle, "notification completion");
			expect(result.status).toBe("fulfilled");
			if (result.status === "fulfilled") expect(result.value?.thinkingLevel).toBe("low");
			expectUnchanged(snapshot(harness, extensionEvents), newer);
			expect(received.map((event) => ("model" in event ? event.model?.id : undefined))).toEqual(["older", "newer"]);
		} finally {
			release.resolve();
			await bounded(cycle, "notification cleanup");
		}
	});

	it("honors an unchanged explicit prompt when the same admission also changes tools", async () => {
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) =>
					pi.on("model_select", (event) => {
						pi.setActiveTools(["read"]);
						return { systemPrompt: event.systemPrompt };
					}),
			],
		});
		harnesses.push(harness);
		const originalPrompt = harness.session.systemPrompt;
		const result = await harness.session.setModel(harness.models[1]!);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(harness.session.systemPrompt).toBe(originalPrompt);
		expect(result).toBeUndefined();
		expect(harness.eventsOfType("system_prompt_change")).toEqual([]);
	});

	it("rejects an invalidated facade even when reload occurs while its accepted notification awaits", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", () => ({ systemPrompt: "OLD" }));
					pi.on("system_prompt_change", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		await harness.session.setModelPolicy(policy("primary"));
		await harness.session.followConfiguredModel();
		const runner = harness.getExtensionRunner();
		const extracted = runner.createContext().sessionSettings.setModelPolicy;
		if (!extracted) throw new Error("Missing model policy API");
		const pending = outcome(extracted(policy("older")));
		try {
			await bounded(entered.promise, "accepted facade notification");
			await bounded(harness.session.reload(), "reload after admission");
			const before = snapshot(harness, extensionEvents);
			release.resolve();
			const result = await bounded(pending, "retired facade notification");
			expect(result.status).toBe("rejected");
			expectUnchanged(snapshot(harness, extensionEvents), before);
		} finally {
			release.resolve();
			await bounded(pending, "retired notification cleanup");
		}
	});

	it("buffers hook thinking, fast-mode and tool-prompt mutations and discards them on rejection", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			models,
			extensionFactories: [
				(pi) =>
					pi.on("model_select", async (event) => {
						if (event.model.id !== "older") return;
						pi.setSessionThinkingLevel("low");
						pi.setSessionFastMode(false);
						pi.setActiveTools(["read"]);
						entered.resolve();
						await release.promise;
						return { systemPrompt: "huge ".repeat(100_000) };
					}),
			],
		});
		harnesses.push(harness);
		const extensionEvents = observeExtensions(harness);
		harness.session.setSessionFastMode(true);
		const tools = harness.session.getActiveToolNames();
		const before = snapshot(harness, extensionEvents);
		const pending = outcome(harness.session.setModel(harness.models[1]!));
		try {
			await bounded(entered.promise, "mutating hook");
			expect(harness.events).toEqual(before.events);
			expect(extensionEvents).toEqual(before.extensionEvents);
			expect(harness.session.getMessageRevision()).toBe(before.revision);
			release.resolve();
			const result = await bounded(pending, "mutating hook rejection");
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.error).toBeInstanceOf(ModelUsabilityBudgetError);
			expectUnchanged(snapshot(harness, extensionEvents), before);
			expect(harness.session.getActiveToolNames()).toEqual(tools);
		} finally {
			release.resolve();
			await bounded(pending, "mutating cleanup");
		}
	});

	for (const operation of ["cycle", "manual", "programmatic", "configured"] as const) {
		it(`preserves ALL events, revision, defaults, history and active/tried/exhausted fallback on rejected ${operation}`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const harness = await createHarness({
				models: [
					{ id: "primary", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
					{ id: "fallback", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
					{ id: "target", reasoning: false, contextWindow: 99_000, maxTokens: 4_000 },
				],
				settings: { retry: { maxRetries: 0, baseDelayMs: 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("model_select", async (event) => {
							if (event.model.id !== "target") return;
							entered.resolve();
							await release.promise;
							return { systemPrompt: "large ".repeat(100_000) };
						});
					},
				],
			});
			harnesses.push(harness);
			const extensionEvents = observeExtensions(harness);
			harness.session.setScopedModels(
				harness.models.map((model) => ({
					model,
					serviceTier: model.id === "fallback" ? "priority" : model.id === "target" ? "flex" : "auto",
				})),
			);
			await harness.session.setModelPolicy({
				models: [
					{ model: "faux/primary", thinkingLevel: "high" },
					{ model: "faux/fallback", thinkingLevel: "high" },
				],
			});
			await harness.session.followConfiguredModel();
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
				fauxAssistantMessage("ok"),
			]);
			await bounded(harness.session.prompt("open real fallback"), "real fallback");
			expect(harness.session.model?.id).toBe("fallback");
			harness.session.setFavoriteModels(harness.models.slice(1).map((model) => ({ model })));
			harness.agent.state.reasoningBaseline = "low";
			const retry = Reflect.get(harness.session, "_retryFallback") as RetryFallbackController;
			expect(retry.activeState).toBeDefined();
			expect(retry.canTryFallback()).toBe(false);
			expect(retry.exhaustedChainKey).toBe("faux/fallback");
			const before = snapshot(harness, extensionEvents);
			const pending = outcome<unknown>(
				operation === "cycle"
					? harness.session.cycleModel()
					: operation === "configured"
						? harness.session.setModelPolicy(policy("target"))
						: harness.session.setModel(harness.models[2]!, { deliberate: operation !== "programmatic" }),
			);
			try {
				await bounded(entered.promise, "rejected admission hook");
				const during = snapshot(harness, extensionEvents);
				expect.soft(during.events).toEqual(before.events);
				expect.soft(during.extensionEvents).toEqual(before.extensionEvents);
				expect.soft(during.revision).toBe(before.revision);
				release.resolve();
				const result = await bounded(pending, "rejected admission");
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") expect(result.error).toBeInstanceOf(ModelUsabilityBudgetError);
				expectUnchanged(snapshot(harness, extensionEvents), before);
			} finally {
				release.resolve();
				await bounded(pending, "rejection cleanup");
			}
		});
	}
});
