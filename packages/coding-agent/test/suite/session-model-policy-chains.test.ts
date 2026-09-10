import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeFallbackChains } from "../../src/core/retry-fallback/chains.ts";
import type { RetryFallbackController } from "../../src/core/retry-fallback/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("session configured model chain merging", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(retry: Record<string, unknown>, reasoning = false) {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning },
				{ id: "faux-2", reasoning },
				{ id: "faux-3", reasoning },
			],
			fileSettings: true,
			settings: { retry: { maxRetries: 0, baseDelayMs: 0, ...retry } },
		});
		harnesses.push(harness);
		return harness;
	}
	function policySettings(h: Harness) {
		const settings = h.getExtensionRunner().createContext().sessionSettings;
		if (!settings.setModelPolicy) throw new Error("Session configured model API is missing");
		return { ...settings, setModelPolicy: settings.setModelPolicy.bind(settings) };
	}

	it("keeps chains for models outside the policy", async () => {
		const h = await setup({ fallbackChains: { "faux/faux-3": ["faux/faux-1"] } });
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }, { model: "faux/faux-2" }] });
		const chains = settings.getRetryFallbackSettings().chains;
		expect(chains["faux/faux-3"]).toEqual(["faux/faux-1"]);
		expect(chains["faux/faux-1"]).toEqual(["faux/faux-1", "faux/faux-2"]);
	});

	it("respects an explicitly disabled modelFallback", async () => {
		const h = await setup({ modelFallback: false });
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }, { model: "faux/faux-2" }] });
		expect(settings.getRetryFallbackSettings().modelFallback).toBe(false);
	});

	// A one-model declaration names no target other than the declared model itself, so
	// replacing wholesale left a self-only lane that deleted the chain the user configured for
	// that same model while still answering hasConfiguredChain() with true - a lane that could
	// never fire. The declaration still leads; the user's configured entries follow it.
	it.each([
		["exact key", "faux/faux-1", undefined],
		["bare family key", "faux-1", undefined],
		["thinking-qualified key", "faux/faux-1:high", "high"],
	] as const)("a one-model declaration keeps the %s chain configured for that model", async (_label, key, level) => {
		const h = await setup({ fallbackChains: { [key]: ["faux/faux-3"] } }, level !== undefined);
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1", thinkingLevel: level }] });
		await h.session.followConfiguredModel();
		expect(h.session.thinkingLevel).toBe(level ?? "off");
		const chains = settings.getRetryFallbackSettings().chains;
		const canonical = canonicalizeFallbackChains(chains, h.modelRegistry);
		const selfSelector = level ? `faux/faux-1:${level}` : "faux/faux-1";
		const resolved = canonical[selfSelector];
		expect(resolved).toEqual([selfSelector, "faux/faux-3"]);
		const retry = Reflect.get(h.session, "_retryFallback") as RetryFallbackController;
		// The declared model owns its key, so the server-side-fallback abort stays armed.
		expect(retry.hasConfiguredChain()).toBe(true);
		expect(retry.canTryFallback()).toBe(true);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
			fauxAssistantMessage("ok"),
		]);
		await h.session.prompt("declared single model fails");
		expect(h.eventsOfType("retry_fallback_applied").map((event) => event.to)).toEqual(["faux/faux-3"]);
	});

	it("a multi-model declaration still wins over base and thinking-qualified configured keys", async () => {
		const h = await setup(
			{ fallbackChains: { "faux/faux-1": ["faux/faux-3"], "faux/faux-1:high": ["faux/faux-3"] } },
			true,
		);
		const settings = policySettings(h);
		await settings.setModelPolicy({
			models: [{ model: "faux/faux-1", thinkingLevel: "high" }, { model: "faux/faux-2" }],
		});
		const chains = settings.getRetryFallbackSettings().chains;
		for (const key of ["faux/faux-1", "faux/faux-1:high"]) {
			expect(chains[key]).toEqual(["faux/faux-1:high", "faux/faux-2"]);
		}
	});

	it("a one-model declaration leaves an explicit modelFallback:false disabled", async () => {
		const h = await setup({ modelFallback: false, fallbackChains: { "faux/faux-1": ["faux/faux-3"] } });
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }] });
		await h.session.followConfiguredModel();
		expect(settings.getRetryFallbackSettings().modelFallback).toBe(false);
		const retry = Reflect.get(h.session, "_retryFallback") as RetryFallbackController;
		expect(retry.canTryFallback()).toBe(false);
	});

	it("leaves a manually chosen outside model on its own configured chain", async () => {
		const h = await setup({ fallbackChains: { "faux/faux-3": ["faux/faux-1"] } });
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }, { model: "faux/faux-2" }] });
		await h.session.setSessionModel(h.models[2]);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
			fauxAssistantMessage("ok"),
		]);
		await h.session.prompt("test");
		expect(h.eventsOfType("retry_fallback_applied").map((event) => event.to)).toEqual(["faux/faux-1"]);
	});
});
