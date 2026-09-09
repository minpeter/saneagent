import { describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry } from "../../src/core/session-manager.ts";

describe("empty durable manual resume", () => {
	it("restores manual model intent even with zero messages", () => {
		const entries: SessionEntry[] = [
			{
				type: "model_change",
				id: "m",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				provider: "local",
				modelId: "manual",
			},
		];
		const context = buildSessionContext(entries);
		expect(context.messages).toHaveLength(0);
		expect(context.model).toEqual({ provider: "local", modelId: "manual" });
	});
});
