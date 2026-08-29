import { describe, expect, it } from "vitest";
import {
	admitContextToolResult,
	resolveBeforeAgentStartMessage,
	resolveCompactionGeometry,
	shouldDeferGraceBand,
} from "../../src/core/extensions/builtin/compaction/orchestration.ts";
import { TOOL_ADMISSION_MARKER_PREFIX } from "../../src/core/extensions/builtin/compaction/tool-admission.ts";

describe("ideal compaction extension wiring decisions", () => {
	it("defers an in-flight compaction inside the grace band", () => {
		expect(
			shouldDeferGraceBand({
				tokens: 82_000,
				thresholdTokens: 80_000,
				leadTokens: 10_000,
				contextWindow: 100_000,
				reserveTokens: 10_000,
				compactionInFlight: true,
				graceBandEnabled: true,
			}),
		).toBe(true);
	});

	it("blocks past the grace cap or when the setting is disabled", () => {
		const base = {
			tokens: 91_000,
			thresholdTokens: 80_000,
			leadTokens: 10_000,
			contextWindow: 100_000,
			reserveTokens: 10_000,
			compactionInFlight: true,
			graceBandEnabled: true,
		};
		expect(shouldDeferGraceBand(base)).toBe(false);
		expect(shouldDeferGraceBand({ ...base, tokens: 82_000, graceBandEnabled: false })).toBe(false);
	});

	it("merges a simultaneous reminder into the pending restoration message", () => {
		const restoration = { customType: "compaction-restoration", content: "restore checkpoint", display: false };
		expect(resolveBeforeAgentStartMessage({ message: restoration, reminder: "budget reminder" })).toEqual({
			...restoration,
			content: "restore checkpoint\n\nbudget reminder",
		});
		expect(
			resolveBeforeAgentStartMessage({
				message: restoration,
				reminder: "budget reminder",
				reminderEnabled: false,
			}),
		).toEqual(restoration);
	});

	it("clamps one configured lead for trigger, grace, and reminder geometry", () => {
		const base = { contextWindow: 200_000, lastYield: undefined };
		const low = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1 },
		});
		const high = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1_000_000 },
		});
		const automatic = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		});
		expect(automatic).toMatchObject({ thresholdTokens: 140_000, leadTokens: 17_500 });
		expect(low).toMatchObject({ thresholdTokens: 140_000, leadTokens: 8192 });
		expect(high).toMatchObject({ thresholdTokens: 140_000, leadTokens: 32_768 });
	});

	it("bypasses admission when an exact marker line sits inside the output", () => {
		const marker = `${TOOL_ADMISSION_MARKER_PREFIX} kept 10 of ~99 tokens; full output at /tmp/x.txt - read it with the read tool if needed]`;
		const marked = `head\n${marker}\ntail`;
		expect(admitContextToolResult(marked, 100_000, "/tmp/spill")).toEqual({ text: marked, admitted: false });
	});
});
