import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("session model policy chain merging", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(retry: Record<string, unknown>) {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fileSettings: true,
			settings: { retry: { maxRetries: 0, baseDelayMs: 0, ...retry } },
		});
		harnesses.push(harness);
		return harness;
	}
	function policySettings(h: Harness) {
		const settings = h.getExtensionRunner().createContext().sessionSettings;
		if (!settings.setModelPolicy) throw new Error("Session model policy API is missing");
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
