import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("startup model history admission and scope provenance (PR14)", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const h = await createHarness({
			models: [
				{ id: "ordinary", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "primary", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "tiny", contextWindow: 1_000, maxTokens: 128 },
			],
		});
		harnesses.push(h);
		const file = join(h.tempDir, "exact.jsonl");
		async function open(manager: SessionManager, options: Partial<CreateAgentSessionOptions> = {}) {
			const extensionsResult = await createTestExtensionsResult(
				[
					(pi) =>
						pi.on("session_start", async (_event, ctx) => {
							if (!ctx.sessionSettings.setModelPolicy) throw new Error("Missing configured model API");
							await ctx.sessionSettings.setModelPolicy({ models: [{ model: "faux/primary" }] });
						}),
				],
				h.tempDir,
			);
			const { session } = await createAgentSession({
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.session.modelRuntime,
				authStorage: h.authStorage,
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "ordinary" }),
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				...options,
			});
			sessions.push(session);
			await session.bindExtensions({ shutdownHandler() {} });
			return session;
		}
		return { h, file, open };
	}

	it.each([false, true])("leaves disk and memory untouched on rejected explicit startup (saved=%s)", async (saved) => {
		// Given an exact fresh path or a real saved configured transcript, without a thinking entry.
		const { h, file, open } = await setup();
		const seed = SessionManager.open(file, h.tempDir);
		if (saved) {
			seed.appendModelChange("faux", "primary", undefined, undefined, undefined, "configured");
			seed.appendMessage(fauxAssistantMessage("saved transcript"));
		}
		const manager = SessionManager.open(file, h.tempDir);
		const beforeDisk = existsSync(file) ? readFileSync(file, "utf8") : undefined;
		const beforeEntries = manager.getEntries();
		const tiny = h.getModel("tiny");
		if (!tiny) throw new Error("Missing tiny fixture");
		// When the explicit startup model cannot be admitted.
		await expect(open(manager, { model: tiny, initialModelProvenance: "cli" })).rejects.toBeInstanceOf(
			ModelUsabilityBudgetError,
		);
		// Then rejection cannot poison the next ordinary exact resume, even by adding thinking state.
		expect.soft(existsSync(file) ? readFileSync(file, "utf8") : undefined).toBe(beforeDisk);
		expect.soft(manager.getEntries()).toEqual(beforeEntries);
		const resumed = await open(SessionManager.open(file, h.tempDir));
		expect(resumed.model?.id).toBe("primary");
		expect(resumed.isConfiguredModelOwned).toBe(true);
	});

	it.each([false, true])(
		"flushes an admitted explicit selection immediately with zero messages (saved=%s)",
		async (saved) => {
			// Given a fresh path or an already durable empty manual session.
			const { h, file, open } = await setup();
			if (saved)
				SessionManager.open(file, h.tempDir).appendModelChange(
					"faux",
					"primary",
					undefined,
					undefined,
					undefined,
					"manual",
				);
			// When a viable explicit startup selection is admitted.
			const session = await open(SessionManager.open(file, h.tempDir), {
				model: h.models[0],
				initialModelProvenance: "cli",
			});
			// Then a separate disk reader sees the manual intent before any message or shutdown.
			expect(session.messages).toHaveLength(0);
			const disk = SessionManager.open(file, h.tempDir);
			expect(disk.getBranch().findLast((entry) => entry.type === "model_change")).toMatchObject({
				modelId: "ordinary",
				selectionIntent: "manual",
			});
			const resumed = await open(disk);
			expect(resumed.model?.id).toBe("ordinary");
			expect(resumed.isConfiguredModelOwned).toBe(false);
		},
	);

	it.each(["cli", "sdk"] as const)(
		"returns a persisted %s scope pick to configured ownership on exact resume",
		async (surface) => {
			// Given a narrowed launch that has actually persisted a transcript.
			const { h, file, open } = await setup();
			const scoped = await open(SessionManager.open(file, h.tempDir), {
				scopedModels: [{ model: h.models[0] }],
				...(surface === "cli" ? { model: h.models[0], initialModelProvenance: "scoped" as const } : {}),
			});
			expect(scoped.model?.id).toBe("ordinary");
			expect(scoped.isConfiguredModelOwned).toBe(false);
			scoped.sessionManager.appendMessage(fauxAssistantMessage("persist the narrowed conversation"));
			scoped.dispose();
			const disk = SessionManager.open(file, h.tempDir);
			expect(disk.buildSessionContext().messages).toHaveLength(1);
			// When the same JSONL is reopened without scope options.
			const resumed = await open(disk);
			// Then the declaration owns selection; scope intent remains distinguishable on disk.
			expect.soft(resumed.model?.id).toBe("primary");
			expect.soft(resumed.isConfiguredModelOwned).toBe(true);
			expect(disk.getBranch().find((entry) => entry.type === "model_change")).toMatchObject({
				modelId: "ordinary",
				selectionIntent: "scoped",
			});
		},
	);

	it.each(["legacy", "manual", "deliberate"] as const)(
		"preserves %s ownership after a persisted scope launch",
		async (intent) => {
			// Given a scope launch followed by a deliberate or legacy model entry, even the configured primary.
			const { h, file, open } = await setup();
			const scoped = await open(SessionManager.open(file, h.tempDir), { scopedModels: [{ model: h.models[0] }] });
			if (intent === "deliberate") await scoped.setSessionModel(h.models[0]);
			else
				scoped.sessionManager.appendModelChange(
					"faux",
					"primary",
					undefined,
					undefined,
					undefined,
					intent === "manual" ? "manual" : undefined,
				);
			scoped.sessionManager.appendMessage(fauxAssistantMessage("persist override"));
			// When the exact transcript resumes without narrowing.
			const resumed = await open(SessionManager.open(file, h.tempDir));
			// Then neither absent intent nor matching model identity grants configured ownership.
			expect(resumed.model?.id).toBe(intent === "deliberate" ? "ordinary" : "primary");
			expect(resumed.isConfiguredModelOwned).toBe(false);
		},
	);
});
