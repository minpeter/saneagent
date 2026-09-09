import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { SessionModelPolicy } from "../../src/core/extensions/types.ts";
import { resolveModelCommandAction } from "../../src/core/model-command-action.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Ownership of the MAIN model selection. A declared policy owns the slot until the USER deliberately
 * takes it; machine events (a programmatic switch by a builtin extension, a fallback window) must
 * never transfer ownership, and the user must be able to hand it back without losing the session.
 */
describe("configured model ownership", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(resumed = false) {
		const sources: string[] = [];
		let pi: { setSessionModel(model: unknown): Promise<boolean> } | undefined;
		const h = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2", reasoning: true }, { id: "faux-3" }],
			settings: { retry: { maxRetries: 0, baseDelayMs: 0 } },
		});
		harnesses.push(h);
		let policy: SessionModelPolicy | undefined = { models: [{ model: "faux/faux-2", thinkingLevel: "high" }] };
		const settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "faux-1" });
		if (resumed) {
			h.sessionManager.appendModelChange("faux", "faux-3");
			h.sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		}
		const extensionsResult = await createTestExtensionsResult(
			[
				(api) => {
					pi = api as unknown as { setSessionModel(model: unknown): Promise<boolean> };
					api.on("model_select", (event) => {
						sources.push(event.source);
					});
					api.on("session_start", async (_event, ctx) => {
						if (!ctx.sessionSettings.setModelPolicy) throw new Error("Session configured model API is missing");
						await ctx.sessionSettings.setModelPolicy(policy);
					});
				},
			],
			h.tempDir,
		);
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			settingsManager: settings,
			sessionManager: h.sessionManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		sessions.push(session);
		await session.bindExtensions({ shutdownHandler() {} });
		return {
			h,
			session,
			settings,
			pi: () => {
				if (!pi) throw new Error("extension API was not captured");
				return pi;
			},
			changePolicy: (next: SessionModelPolicy | undefined) => {
				policy = next;
			},
			sources,
		};
	}

	it("#given a programmatic switch away and back #when the policy changes #then the policy still owns the slot", async () => {
		const { h, session, changePolicy } = await setup();
		expect(session.model?.id).toBe("faux-2");

		// What a builtin does for fast mode: swap to a variant and back, with no user involvement.
		await session.setSessionModel(h.models[2], { deliberate: false });
		await session.setSessionModel(h.models[1], { deliberate: false });

		changePolicy({ models: [{ model: "faux/faux-1" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-1");
	});

	it("#given a builtin toggling through the extension surface #when the policy changes #then ownership survives", async () => {
		const h2 = await setup();
		const { h, session, changePolicy } = h2;
		expect(await h2.pi().setSessionModel(h.models[2])).toBe(true);
		expect(await h2.pi().setSessionModel(h.models[1])).toBe(true);
		changePolicy({ models: [{ model: "faux/faux-1" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-1");
	});

	it("#given a deliberate user pick #when the policy changes #then the user keeps the slot", async () => {
		const { h, session, changePolicy } = await setup();
		await session.setSessionModel(h.models[2]);
		changePolicy({ models: [{ model: "faux/faux-1" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-3");
	});

	it("#given a fallback window #when a changed policy arrives #then a machine event does not take ownership", async () => {
		const h2 = await setup();
		const { h, session, changePolicy } = h2;
		// A single-entry policy disables cross-model fallback, so widen it first.
		changePolicy({ models: [{ model: "faux/faux-2", thinkingLevel: "high" }, { model: "faux/faux-3" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-2");

		// Open a real fallback window: the primary errors, the chain moves on.
		expect(session.getRetryFallbackSettings().modelFallback).toBe(true);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unauthorized" }),
			fauxAssistantMessage("ok"),
		]);
		await session.prompt("open a fallback window");
		// The window is observable on the session that actually ran the turn.
		expect(session.model?.id).toBe("faux-3");

		// A config edit lands while that window is still the reason we are off-primary.
		// Nobody picked anything, so the policy must keep the slot.
		changePolicy({ models: [{ model: "faux/faux-1" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-1");
	});

	it("#given a deliberate pick #when the user returns to the policy #then the configured primary is reapplied", async () => {
		const h2 = await setup();
		const { h, session } = h2;
		await session.setSessionModel(h.models[2]);
		expect(session.model?.id).toBe("faux-3");

		// The return path must work on the CURRENTLY loaded policy, without a config change: an
		// identical re-push early-returns, so this cannot be "flip the flag and push again".
		await session.followConfiguredModel();
		expect(session.model?.id).toBe("faux-2");
		expect(session.thinkingLevel).toBe("high");
	});

	it("#given the policy is followed again #when the config later changes #then the new primary applies", async () => {
		const h2 = await setup();
		const { h, session, changePolicy } = h2;
		await session.setSessionModel(h.models[2]);
		await session.followConfiguredModel();
		changePolicy({ models: [{ model: "faux/faux-1" }] });
		await session.reload();
		expect(session.model?.id).toBe("faux-1");
	});

	it("#given no policy is configured #when returning #then it fails without touching the active model", async () => {
		const h2 = await setup();
		const { h, session, changePolicy } = h2;
		await session.setSessionModel(h.models[2]);
		changePolicy(undefined);
		await session.reload();
		await expect(session.followConfiguredModel()).rejects.toThrow();
		expect(session.model?.id).toBe("faux-3");
	});

	it("#given a resumed session #when the user returns to the policy #then the configured primary applies", async () => {
		const h2 = await setup(true);
		const { session } = h2;
		// A resumed session deliberately starts unowned by the policy (the restored pick wins).
		expect(session.model?.id).toBe("faux-3");
		await session.followConfiguredModel();
		expect(session.model?.id).toBe("faux-2");
	});

	it("#given the user cycled models #when they return to the policy #then the configured primary applies", async () => {
		const h2 = await setup();
		const { h, session } = h2;
		session.setFavoriteModels([{ model: h.models[0] }, { model: h.models[2] }]);
		await session.cycleModel();
		// Cycling is a deliberate pick, so it must take the slot away from the policy.
		expect(session.model?.id).not.toBe("faux-2");
		await session.followConfiguredModel();
		expect(session.model?.id).toBe("faux-2");
		expect(h.models.length).toBe(3);
	});

	it("#given a policy selection #when the source is inspected #then it is distinct from a history restore", async () => {
		const h2 = await setup();
		const { h, session, sources } = h2;
		// Startup application of the declared policy.
		expect(sources).toContain("configured");
		expect(sources).not.toContain("restore");

		// Returning to the policy is also policy provenance, not a history restore.
		sources.length = 0;
		await session.setSessionModel(h.models[2]);
		expect(sources).toContain("set");
		sources.length = 0;
		await session.followConfiguredModel();
		expect(sources).toEqual(["configured"]);
	});

	it("#given a resumed session #when history restores the model #then the source is still restore", async () => {
		const h2 = await setup(true);
		const { session, sources } = h2;
		expect(session.model?.id).toBe("faux-3");
		// A history restore must keep its own provenance; only policy paths get the new value.
		expect(sources).not.toContain("configured");
	});

	it("#given the /model configured route #when a policy is configured #then the routed action reapplies it", async () => {
		const h2 = await setup();
		const { h, session } = h2;
		await session.setSessionModel(h.models[2]);
		expect(session.model?.id).toBe("faux-3");

		// Drive the real routing decision the TUI uses, then perform what it resolved to.
		const action = resolveModelCommandAction("configured", { hasConfiguredModel: session.hasConfiguredModel });
		expect(action).toEqual({ kind: "follow-configured" });
		if (action.kind === "follow-configured") await session.followConfiguredModel();
		expect(session.model?.id).toBe("faux-2");
	});

	it("#given no policy #when the /model configured route is resolved #then it reports without switching", async () => {
		const h2 = await setup();
		const { h, session, changePolicy } = h2;
		await session.setSessionModel(h.models[2]);
		changePolicy(undefined);
		await session.reload();
		expect(session.hasConfiguredModel).toBe(false);

		const action = resolveModelCommandAction("configured", { hasConfiguredModel: session.hasConfiguredModel });
		expect(action.kind).toBe("error");
		// Nothing was switched by merely asking.
		expect(session.model?.id).toBe("faux-3");
	});

	it("#given a policy with no authenticated model #when returning #then it rejects and keeps the model", async () => {
		const h2 = await setup();
		const { h, session } = h2;
		session.modelRuntime.registerProvider("unauthed", {
			baseUrl: "http://127.0.0.1:1",
			api: h.models[0].api,
			models: [{ ...h.models[0], id: "only" }],
		});
		await session.setSessionModel(h.models[2]);
		expect(session.model?.id).toBe("faux-3");

		// Swap the loaded policy for one nothing can authenticate. The manual pick already took the
		// slot, so this push does not try to select - it just becomes the policy we would return to.
		await session.setModelPolicy({ models: [{ model: "unauthed/only" }] });
		expect(session.hasConfiguredModel).toBe(true);

		// The route still offers the action, and applying it must fail loudly without switching.
		expect(resolveModelCommandAction("configured", { hasConfiguredModel: session.hasConfiguredModel })).toEqual({
			kind: "follow-configured",
		});
		await expect(session.followConfiguredModel()).rejects.toThrow();
		expect(session.model?.id).toBe("faux-3");
	});
});
