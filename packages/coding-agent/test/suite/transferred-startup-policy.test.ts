import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("transferred startup policy integration", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const h of harnesses.splice(0)) h.cleanup();
	});
	async function open(kind: "fresh" | "enabled" | "manual" | "cli" | "scoped", bindPolicy = true) {
		const h = await createHarness({ models: [{ id: "ordinary" }, { id: "primary" }, { id: "manual" }] });
		harnesses.push(h);
		let manager = SessionManager.inMemory(h.tempDir);
		if (kind === "manual") {
			const file = join(h.tempDir, "empty-manual.jsonl");
			writeFileSync(
				file,
				[
					{
						type: "session",
						version: 3,
						id: "11111111-1111-4111-8111-111111111111",
						timestamp: "2026-09-08T00:00:00Z",
						cwd: h.tempDir,
					},
					{
						type: "model_change",
						id: "m",
						parentId: null,
						timestamp: "2026-09-08T00:00:01Z",
						provider: "faux",
						modelId: "manual",
						selectionIntent: "manual",
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			manager = SessionManager.open(file, h.tempDir);
			expect(manager.buildSessionContext().messages).toHaveLength(0);
		}
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						if (!ctx.sessionSettings.setModelPolicy) throw new Error("Missing policy API");
						await ctx.sessionSettings.setModelPolicy({ models: [{ model: "faux/primary" }] });
					});
				},
			],
			h.tempDir,
		);
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			sessionManager: manager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "faux",
				defaultModel: "ordinary",
				...(kind === "enabled" ? { enabledModels: ["faux/ordinary", "faux/primary"] } : {}),
			}),
			...(kind === "cli" ? { model: h.models[0], initialModelProvenance: "cli" as const } : {}),
			...(kind === "scoped" ? { scopedModels: [{ model: h.models[0] }] } : {}),
		});
		sessions.push(session);
		if (bindPolicy) await session.bindExtensions({ shutdownHandler() {} });
		return session;
	}
	it("fresh startup selects the policy primary", async () => {
		const session = await open("fresh");
		expect(session.model?.id).toBe("primary");
		expect(session.isConfiguredModelOwned).toBe(true);
	});
	it("settings enabledModels does not disarm policy", async () => {
		const session = await open("enabled");
		expect(session.model?.id).toBe("primary");
		expect(session.isConfiguredModelOwned).toBe(true);
		expect(session.settingsManager.getDefaultModel()).toBe("ordinary");
		expect(session.settingsManager.getEnabledModels()).toEqual(["faux/ordinary", "faux/primary"]);
	});
	it("keeps settings-derived startup selection when no policy is bound", async () => {
		const session = await open("enabled", false);
		expect(session.model?.id).toBe("ordinary");
		expect(session.scopedModels.map(({ model }) => model.id)).toEqual(["ordinary", "primary"]);
	});
	it("empty-message durable manual intent survives policy binding", async () => {
		const session = await open("manual");
		expect(session.model?.id).toBe("manual");
		expect(session.isConfiguredModelOwned).toBe(false);
		expect(session.sessionManager.getBranch().filter((entry) => entry.type === "model_change")).toMatchObject([
			{ modelId: "manual", selectionIntent: "manual" },
		]);
		await session.reload();
		expect(session.model?.id).toBe("manual");
		expect(session.isConfiguredModelOwned).toBe(false);
		expect(session.settingsManager.getDefaultModel()).toBe("ordinary");
	});
	it.each(["cli", "scoped"] as const)("preserves explicit %s options", async (kind) => {
		const session = await open(kind);
		expect(session.model?.id).toBe("ordinary");
		expect(session.isConfiguredModelOwned).toBe(false);
	});
});
