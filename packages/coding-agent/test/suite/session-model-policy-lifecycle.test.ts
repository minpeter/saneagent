import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { SessionModelPolicy } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("configured model selection lifecycle", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(selection: "default" | "cli" | "sdk" | "restored" = "default", unauthenticatedFirst = false) {
		const h = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2", reasoning: true }, { id: "faux-3" }],
		});
		harnesses.push(h);
		h.session.modelRuntime.registerProvider("unauthed", {
			baseUrl: "http://127.0.0.1:1",
			api: h.models[0].api,
			models: [{ ...h.models[0], id: "first" }],
		});
		let policy: SessionModelPolicy | undefined = { models: [{ model: "faux/faux-2", thinkingLevel: "high" }] };
		if (unauthenticatedFirst) policy.models = [{ model: "unauthed/first" }, ...policy.models];
		let enabled = true;
		const settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "faux-1" });
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						if (!enabled) return;
						if (!ctx.sessionSettings.setModelPolicy) throw new Error("Session configured model API is missing");
						await ctx.sessionSettings.setModelPolicy(policy);
					});
				},
			],
			h.tempDir,
		);
		if (selection === "restored") {
			h.sessionManager.appendModelChange("faux", "faux-3");
			h.sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		}
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			settingsManager: settings,
			sessionManager: h.sessionManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			...(selection === "cli" || selection === "sdk" ? { model: h.models[0] } : {}),
			...(selection === "cli" ? { initialModelProvenance: "cli" as const } : {}),
		});
		sessions.push(session);
		await session.bindExtensions({ shutdownHandler() {} });
		return {
			h,
			session,
			settings,
			changePolicy: (next: SessionModelPolicy | undefined) => {
				policy = next;
			},
			disable: () => {
				enabled = false;
			},
		};
	}

	it("selects the configured primary for SDK defaults without changing saved defaults", async () => {
		const { session, settings } = await setup();
		expect(session.model?.id).toBe("faux-2");
		expect(session.thinkingLevel).toBe("high");
		expect(settings.getDefaultModel()).toBe("faux-1");
		expect(settings.getDefaultThinkingLevel()).toBeUndefined();
	});
	it("selects the first authenticated configured provider and retains the full ordered chain", async () => {
		const { session } = await setup("default", true);
		expect(session.modelRuntime.hasConfiguredAuth("unauthed")).toBe(false);
		expect(session.modelRuntime.hasConfiguredAuth("faux")).toBe(true);
		expect(session.model?.provider).toBe("faux");
		expect(session.model?.id).toBe("faux-2");
		expect(session.getRetryFallbackSettings().chains).toEqual({
			"unauthed/first": ["unauthed/first", "faux/faux-2:high"],
			"faux/faux-2": ["unauthed/first", "faux/faux-2:high"],
		});
	});
	it("rejects a policy with no authenticated configured provider without replacing the prior policy", async () => {
		const { session } = await setup();
		await expect(session.setModelPolicy({ models: [{ model: "unauthed/first" }] })).rejects.toThrow();
		expect(session.model?.id).toBe("faux-2");
		expect(session.getRetryFallbackSettings().chains).toEqual({ "faux/faux-2": ["faux/faux-2:high"] });
	});
	it.each(["cli", "sdk", "restored"] as const)("preserves %s selection on startup and reload", async (selection) => {
		const { session } = await setup(selection);
		const expected = selection === "restored" ? "faux-3" : "faux-1";
		expect(session.model?.id).toBe(expected);
		await session.reload();
		expect(session.model?.id).toBe(expected);
	});
	it("refreshes config-owned selection but preserves a later manual choice", async () => {
		const { session, h, changePolicy } = await setup();
		changePolicy({ models: [{ model: "faux/faux-1" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-1");
		await session.setSessionModel(h.models[2]);
		changePolicy({ models: [{ model: "faux/faux-2" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-3");
	});
	it("clears the override when the extension disappears on reload", async () => {
		const { session, disable } = await setup();
		expect(session.getRetryFallbackSettings().modelFallback).toBe(false);
		disable();
		await session.reload();
		expect(session.getRetryFallbackSettings().chains).toEqual({});
		expect(session.getRetryFallbackSettings().modelFallback).toBe(true);
	});
});
