import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("session configured model", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup() {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fileSettings: true,
			settings: { retry: { maxRetries: 0, baseDelayMs: 0, fallbackChains: { "faux/faux-1": ["faux/faux-3"] } } },
		});
		harnesses.push(harness);
		return harness;
	}
	function policySettings(h: Harness) {
		const settings = h.getExtensionRunner().createContext().sessionSettings;
		if (!settings.setModelPolicy) throw new Error("Session configured model API is missing");
		return { ...settings, setModelPolicy: settings.setModelPolicy.bind(settings) };
	}
	it("layers over settings chains, preserves explicit model, and never writes settings", async () => {
		const h = await setup();
		const path = join(h.tempDir, "agent", "settings.json");
		const before = readFileSync(path, "utf8");
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }, { model: "faux/faux-2" }] });
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
			fauxAssistantMessage("ok"),
		]);
		await h.session.prompt("test");
		expect(h.eventsOfType("retry_fallback_applied").map((event) => event.to)).toEqual(["faux/faux-2"]);
		expect(settings.getRetryFallbackSettings().chains).toEqual({
			"faux/faux-1": ["faux/faux-1", "faux/faux-2"],
			"faux/faux-2": ["faux/faux-1", "faux/faux-2"],
		});
		await h.settingsManager.flush();
		expect(readFileSync(path, "utf8")).toBe(before);
		await settings.setModelPolicy(undefined);
		expect(settings.getRetryFallbackSettings().chains).toEqual({ "faux/faux-1": ["faux/faux-3"] });
	});
	it("one model keeps fallback enabled for unrelated manual models", async () => {
		const h = await setup();
		const settings = policySettings(h);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }] });
		await h.session.setSessionModel(h.models[2]);
		expect(settings.getRetryFallbackSettings().modelFallback).toBe(true);
		await settings.setModelPolicy({ models: [{ model: "faux/faux-2" }] });
		expect(h.session.model?.id).toBe("faux-3");
		await settings.setModelPolicy({ models: [{ model: "faux/faux-1" }, { model: "faux/faux-2" }] });
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" })]);
		await h.session.prompt("outside chain");
		expect(h.eventsOfType("retry_fallback_applied")).toEqual([]);
	});
	it("rejects invalid entries atomically instead of expanding bare names", async () => {
		const h = await setup();
		const settings = policySettings(h);
		for (const models of [[], [{ model: "faux-1" }], [{ model: "faux/missing" }]]) {
			await expect(settings.setModelPolicy({ models })).rejects.toThrow();
		}
		expect(settings.getRetryFallbackSettings().chains).toEqual({ "faux/faux-1": ["faux/faux-3"] });
	});
});
