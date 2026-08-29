import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import {
	admitToolResult,
	containsToolAdmissionMarker,
	resolveToolResultAdmissionCapTokens,
	TOOL_ADMISSION_MARKER_PREFIX,
} from "../../src/core/extensions/builtin/compaction/tool-admission.ts";

function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "tool-admission-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveToolResultAdmissionCapTokens", () => {
	it("scales at 5% of the context window", () => {
		expect(resolveToolResultAdmissionCapTokens(200_000)).toBe(10_000);
	});

	it("clamps to the 50K ceiling for huge windows", () => {
		expect(resolveToolResultAdmissionCapTokens(1_000_000)).toBe(50_000);
	});

	it("clamps to the 8192 floor for small windows", () => {
		expect(resolveToolResultAdmissionCapTokens(64_000)).toBe(8192);
	});
});

describe("admitToolResult", () => {
	it("passes through under-cap text without writing a spill file", () => {
		const spillDir = join(tmpRoot, "spill");
		const text = "small tool output\n".repeat(10);

		const result = admitToolResult({ text, contextWindow: 200_000, spillDir });

		expect(result.text).toBe(text);
		expect(result.spilled).toBe(false);
		expect(result.spillPath).toBeUndefined();
		expect(existsSync(spillDir)).toBe(false);
	});

	it("spills over-cap text and returns a head/tail excerpt pointing at the file", () => {
		const spillDir = join(tmpRoot, "spill");
		const contextWindow = 200_000;
		const cap = resolveToolResultAdmissionCapTokens(contextWindow);
		const head = "HEAD-SENTINEL-START\n";
		const tail = "\nTAIL-SENTINEL-END";
		const text = `${head}${"x".repeat(cap * 8)}${tail}`;

		const result = admitToolResult({ text, contextWindow, spillDir });

		expect(result.spilled).toBe(true);
		expect(result.spillPath).toBeTruthy();
		const spillPath = result.spillPath as string;
		expect(existsSync(spillPath)).toBe(true);
		expect(readFileSync(spillPath, "utf-8")).toBe(text);
		expect(readdirSync(spillDir)).toHaveLength(1);
		expect(/^tool-result-\d+-[0-9a-f]{6}\.txt$/.test(readdirSync(spillDir)[0])).toBe(true);

		expect(result.text).toContain(TOOL_ADMISSION_MARKER_PREFIX);
		expect(result.text).toContain(spillPath);
		expect(result.text.startsWith(head)).toBe(true);
		expect(result.text.endsWith(tail)).toBe(true);
		expect(estimateTextTokens(result.text)).toBeLessThanOrEqual(Math.ceil(cap * 1.1));
	});

	it("formats the marker line with kept and total token counts", () => {
		const spillDir = join(tmpRoot, "spill");
		const contextWindow = 200_000;
		const cap = resolveToolResultAdmissionCapTokens(contextWindow);
		const text = "y".repeat(cap * 8);

		const result = admitToolResult({ text, contextWindow, spillDir });
		const markerLine = result.text.split("\n").find((line) => line.startsWith(TOOL_ADMISSION_MARKER_PREFIX));

		expect(markerLine).toBeDefined();
		const match = (markerLine as string).match(
			/^\[tool result truncated: kept (\d+) of ~(\d+) tokens; full output at (.+) - read it with the read tool if needed\]$/,
		);
		expect(match).not.toBeNull();
		const [, kept, total, path] = match as RegExpMatchArray;
		expect(Number(kept)).toBeLessThanOrEqual(Number(total));
		expect(Number(total)).toBe(estimateTextTokens(text));
		expect(path).toBe(result.spillPath);
	});

	it("does not re-spill already-admitted text when the window shrinks on a model switch", () => {
		const spillDir = join(tmpRoot, "spill");
		const wideWindow = 1_000_000;
		const text = `PROLOGUE\n${"z".repeat(100_000 * 4)}\nEPILOGUE`;

		const first = admitToolResult({ text, contextWindow: wideWindow, spillDir });
		expect(first.spilled).toBe(true);
		expect(readdirSync(spillDir)).toHaveLength(1);
		expect(containsToolAdmissionMarker(first.text)).toBe(true);

		// The excerpt still exceeds the 8192-token cap of a 64K window, so a naive
		// startsWith() bypass would spill it a second time and corrupt the pointer chain.
		expect(estimateTextTokens(first.text)).toBeGreaterThan(resolveToolResultAdmissionCapTokens(64_000));

		const second = admitToolResult({ text: first.text, contextWindow: 64_000, spillDir });

		expect(second.spilled).toBe(false);
		expect(second.spillPath).toBeUndefined();
		expect(second.text).toBe(first.text);
		expect(readdirSync(spillDir)).toHaveLength(1);
		expect(readFileSync(first.spillPath as string, "utf-8")).toBe(text);
	});

	it("still admits ordinary output that merely mentions the marker prefix", () => {
		const spillDir = join(tmpRoot, "spill");
		const contextWindow = 200_000;
		const cap = resolveToolResultAdmissionCapTokens(contextWindow);
		const text = `${TOOL_ADMISSION_MARKER_PREFIX} is the prefix we grep for\n${"q".repeat(cap * 8)}`;

		const result = admitToolResult({ text, contextWindow, spillDir });

		expect(result.spilled).toBe(true);
		expect(readdirSync(spillDir)).toHaveLength(1);
		expect(readFileSync(result.spillPath as string, "utf-8")).toBe(text);
	});
});

describe("containsToolAdmissionMarker", () => {
	it("detects a marker line in the middle of head/tail excerpts", () => {
		const spillDir = join(tmpRoot, "spill");
		const cap = resolveToolResultAdmissionCapTokens(200_000);
		const result = admitToolResult({ text: `A\n${"w".repeat(cap * 8)}\nB`, contextWindow: 200_000, spillDir });

		expect(result.text.startsWith(TOOL_ADMISSION_MARKER_PREFIX)).toBe(false);
		expect(containsToolAdmissionMarker(result.text)).toBe(true);
	});

	it("detects a marker line at the very start", () => {
		const marker = `${TOOL_ADMISSION_MARKER_PREFIX} kept 10 of ~99 tokens; full output at /tmp/x.txt - read it with the read tool if needed]`;

		expect(containsToolAdmissionMarker(marker)).toBe(true);
		expect(containsToolAdmissionMarker(`${marker}\ntail`)).toBe(true);
	});

	it("rejects loose mentions of the prefix inside ordinary output", () => {
		expect(containsToolAdmissionMarker("")).toBe(false);
		expect(containsToolAdmissionMarker(`grep hit: ${TOOL_ADMISSION_MARKER_PREFIX} appears here`)).toBe(false);
		expect(
			containsToolAdmissionMarker(
				`log line ${TOOL_ADMISSION_MARKER_PREFIX} kept 1 of ~2 tokens; full output at /tmp/x.txt - read it with the read tool if needed]`,
			),
		).toBe(false);
		expect(
			containsToolAdmissionMarker(
				`${TOOL_ADMISSION_MARKER_PREFIX} kept many of ~lots tokens; full output at /tmp/x.txt - read it with the read tool if needed]`,
			),
		).toBe(false);
	});
});
