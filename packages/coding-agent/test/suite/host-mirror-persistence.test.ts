import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("host mirror persistence ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("updates mirror indexes without persisting transport entries", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const host = SessionManager.create(harness.tempDir, harness.tempDir);
		host.appendModelChange("faux", "faux-1", undefined, undefined, undefined, "manual");
		const path = host.getSessionFile();
		if (!path) throw new Error("Expected persistent host session");
		const mirror = SessionManager.open(path);
		const capture = SessionManager.inMemory(harness.tempDir);
		capture.appendCustomEntry("setup-state", { marker: true });
		capture.appendSessionInfo("setup session");
		for (const entry of capture.getEntries()) host.appendEntry(entry);
		const persisted = readFileSync(path, "utf8");

		for (const entry of capture.getEntries()) mirror.appendEntry(entry, { persist: false });

		expect(mirror.getEntries()).toEqual(host.getEntries());
		expect(mirror.getBranch()).toEqual(capture.getBranch());
		expect(mirror.getLeafId()).toBe(capture.getLeafId());
		expect(mirror.getSessionName()).toBe("setup session");
		for (const entry of capture.getEntries()) expect(mirror.getEntry(entry.id)).toEqual(entry);
		expect(readFileSync(path, "utf8")).toBe(persisted);
	});

	it("rejects retained settings objects and extracted methods at invocation after invalidation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const settings = runner.createContext().sessionSettings;
		const setPolicy = settings.setModelPolicy;
		const getSettings = settings.getRetryFallbackSettings;
		if (!setPolicy) throw new Error("Expected configured model API");
		await setPolicy({ models: [{ model: `${harness.models[0].provider}/${harness.models[0].id}` }] });
		const before = harness.session.getRetryFallbackSettings();

		runner.invalidate();

		expect(() => settings.setModelPolicy).toThrow();
		expect(() => setPolicy(undefined)).toThrow();
		expect(() => getSettings()).toThrow();
		expect(harness.session.getRetryFallbackSettings()).toEqual(before);
	});
});
