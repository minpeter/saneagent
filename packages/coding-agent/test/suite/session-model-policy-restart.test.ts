import { stripVTControlCharacters as stripAnsi } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { FooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("policy selection across session restart", () => {
	beforeAll(() => initTheme("dark"));
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const h = await createHarness({
			models: [{ id: "ordinary" }, { id: "primary", reasoning: true }, { id: "other", reasoning: true }],
			persistSession: true,
		});
		harnesses.push(h);
		let primary = "primary";
		let api: ExtensionAPI | undefined;
		const settings = SettingsManager.inMemory({
			defaultProvider: "faux",
			defaultModel: "ordinary",
			defaultThinkingLevel: "low",
		});
		async function open(manager: SessionManager, explicit = false) {
			const extensionsResult = await createTestExtensionsResult(
				[
					(pi) => {
						api = pi;
						pi.on("session_start", async (_event, ctx) => {
							if (!ctx.sessionSettings.setModelPolicy) throw new Error("Session configured model API is missing");
							await ctx.sessionSettings.setModelPolicy({
								models: [{ model: `faux/${primary}`, thinkingLevel: "high" }],
							});
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
				sessionManager: manager,
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				...(explicit ? { model: h.models[0], initialModelProvenance: "cli" as const } : {}),
			});
			sessions.push(session);
			await session.bindExtensions({ shutdownHandler() {} });
			return session;
		}
		const session = await open(h.sessionManager);
		// A saved conversation, without a provider call. Empty sessions intentionally are not flushed.
		h.sessionManager.appendMessage(fauxAssistantMessage("local fixture"));
		const file = h.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session path");
		return {
			h,
			session,
			settings,
			changePolicy() {
				primary = "other";
			},
			async programmaticPick() {
				if (!api) throw new Error("Missing extension API");
				await api.setModel(h.models[0]);
			},
			async restart(explicit = false) {
				session.dispose();
				return open(SessionManager.open(file), explicit);
			},
		};
	}

	it("keeps a cycle selection manual after reopening", async () => {
		// Given a policy-owned session and an actual favorite-model cycle.
		const { h, session, changePolicy, restart } = await setup();
		session.setFavoriteModels([{ model: h.models[0] }, { model: h.models[1] }]);
		await session.cycleModel();
		changePolicy();
		// When the saved session is reopened.
		const resumed = await restart();
		// Then the deliberate cycle is not replaced by the policy.
		expect(resumed.model?.id).toBe("ordinary");
		expect(footer(resumed)).not.toContain("(configured)");
	});

	it("treats legacy history without intent as an override, without model equality guessing", async () => {
		// Given an old-style manual entry that happens to name the policy primary.
		const { h, changePolicy, restart } = await setup();
		h.sessionManager.appendModelChange("faux", "primary");
		changePolicy();
		// When the persisted branch is reopened.
		const resumed = await restart();
		// Then absent provenance is not silently migrated to policy ownership.
		expect(resumed.model?.id).toBe("primary");
		expect(footer(resumed)).not.toContain("(configured)");
	});

	function footer(session: AgentSession) {
		const data = new FooterDataProvider(session.sessionManager.getCwd());
		try {
			return new FooterComponent(session, data).render(180).map(stripAnsi).join("\n");
		} finally {
			data.dispose();
		}
	}

	it("renders policy provenance when extension binding finished before the footer subscribed", async () => {
		// Given a real SDK session whose startup policy event has already fired.
		const { session } = await setup();
		// When a footer is constructed after binding, as on startup.
		const rendered = footer(session);
		// Then the label reflects current session state, not a missed event.
		expect(rendered).toContain("(configured) faux/primary:high");
	});

	it("restores policy ownership and tuning from a reopened session after returning to policy", async () => {
		const { h, session, restart, settings } = await setup();
		await session.setSessionModel(h.models[0]);
		await session.followConfiguredModel();
		const resumed = await restart();
		expect(resumed.model?.id).toBe("primary");
		expect(resumed.thinkingLevel).toBe("high");
		expect(footer(resumed)).toContain("(configured) faux/primary:high");
		expect(settings.getDefaultModel()).toBe("ordinary");
		expect(settings.getDefaultThinkingLevel()).toBe("low");
	});

	it("applies changed policy on restart instead of treating the previous primary as a user override", async () => {
		const { changePolicy, restart } = await setup();
		changePolicy();
		const resumed = await restart();
		expect(resumed.model?.id).toBe("other");
		expect(resumed.thinkingLevel).toBe("high");
	});

	it.each(["ordinary", "primary"])("preserves deliberate %s selection across restart and reload", async (id) => {
		const { h, session, changePolicy, restart } = await setup();
		const model = h.getModel(id);
		if (!model) throw new Error("Missing test model");
		await session.setSessionModel(model);
		changePolicy();
		const resumed = await restart();
		await resumed.reload();
		expect(resumed.model?.id).toBe(id);
		expect(footer(resumed)).not.toContain("(configured)");
	});

	it("does not persist a programmatic pi.setModel as a deliberate override", async () => {
		const { programmaticPick, changePolicy, restart } = await setup();
		await programmaticPick();
		changePolicy();
		const resumed = await restart();
		expect(resumed.model?.id).toBe("other");
	});

	it("keeps an explicit launch model above restored policy intent on subsequent restarts", async () => {
		const { restart, changePolicy } = await setup();
		const explicit = await restart(true);
		expect(explicit.model?.id).toBe("ordinary");
		explicit.dispose();
		changePolicy();
		const resumed = await restart();
		expect(resumed.model?.id).toBe("ordinary");
	});

	it("does not retain another session's policy label after footer session replacement", async () => {
		const { session, h } = await setup();
		const data = new FooterDataProvider(h.tempDir);
		try {
			const component = new FooterComponent(session, data);
			component.setSession(h.session);
			expect(component.render(180).map(stripAnsi).join("\n")).not.toContain("(configured)");
		} finally {
			data.dispose();
		}
	});
});
