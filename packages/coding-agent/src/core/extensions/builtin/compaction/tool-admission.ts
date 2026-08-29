/**
 * Always-on admission cap for tool results.
 *
 * Oversized tool output is the dominant driver of single-step context bursts, so it is
 * capped at the entrance instead of waiting for an emergency/compaction-budget pass
 * (see `tool-truncation.ts`). The full output is spilled to disk and the model gets a
 * head/tail excerpt plus a pointer it can re-read with the read tool.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../../../compaction/index.ts";

const MAX_ADMISSION_CAP_TOKENS = 50_000;
const MIN_ADMISSION_CAP_TOKENS = 8192;
const ADMISSION_CAP_FRACTION = 0.05;
const HEAD_BUDGET_FRACTION = 0.6;
const TAIL_BUDGET_FRACTION = 0.2;
const MAX_SHRINK_PASSES = 8;

export const TOOL_ADMISSION_MARKER_PREFIX = "[tool result truncated:";

/**
 * A whole line of the exact shape emitted by `buildMarker`. Anchored per line (`m` flag)
 * so the marker is found wherever it sits - including the middle of a head/tail excerpt -
 * while ordinary output that merely mentions the prefix mid-line is not matched.
 */
const TOOL_ADMISSION_MARKER_LINE =
	/^\[tool result truncated: kept \d+ of ~\d+ tokens; full output at .+ - read it with the read tool if needed\]$/m;

/** True when `text` already carries an admission marker line, at any position. */
export function containsToolAdmissionMarker(text: string): boolean {
	return TOOL_ADMISSION_MARKER_LINE.test(text);
}

export interface AdmitToolResultInput {
	text: string;
	contextWindow: number;
	spillDir: string;
}

export interface AdmitToolResultOutput {
	text: string;
	spilled: boolean;
	spillPath?: string;
}

/** Token budget a single tool result may occupy before it is spilled to disk. */
export function resolveToolResultAdmissionCapTokens(contextWindow: number): number {
	return Math.min(
		MAX_ADMISSION_CAP_TOKENS,
		Math.max(MIN_ADMISSION_CAP_TOKENS, Math.floor(ADMISSION_CAP_FRACTION * contextWindow)),
	);
}

function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

function buildMarker(keptTokens: number, totalTokens: number, spillPath: string): string {
	return `${TOOL_ADMISSION_MARKER_PREFIX} kept ${keptTokens} of ~${totalTokens} tokens; full output at ${spillPath} - read it with the read tool if needed]`;
}

function spillToFile(spillDir: string, text: string): string {
	mkdirSync(spillDir, { recursive: true });
	const spillPath = join(spillDir, `tool-result-${Date.now()}-${randomBytes(3).toString("hex")}.txt`);
	writeFileSync(spillPath, text, "utf-8");
	return spillPath;
}

function buildExcerpt(text: string, budgetChars: number, totalTokens: number, spillPath: string): string {
	const headChars = Math.max(1, Math.floor(budgetChars * HEAD_BUDGET_FRACTION));
	const tailChars = Math.max(1, Math.floor(budgetChars * TAIL_BUDGET_FRACTION));
	const head = text.slice(0, headChars);
	const tail = text.slice(Math.max(headChars, text.length - tailChars));
	const keptTokens = estimateTextTokens(head) + estimateTextTokens(tail);
	return `${head}\n${buildMarker(keptTokens, totalTokens, spillPath)}\n${tail}`;
}

/**
 * Cap a tool result at admission time. Under-cap text passes through untouched; over-cap
 * text is written to `spillDir` in full and replaced by a head/tail excerpt.
 *
 * Already-admitted text is returned unchanged: re-spilling an excerpt would persist the
 * excerpt (not the original output) and break the read-back pointer chain. This matters
 * when a model switch shrinks the context window below the cap the excerpt was built for.
 */
export function admitToolResult(input: AdmitToolResultInput): AdmitToolResultOutput {
	const { text, contextWindow, spillDir } = input;
	if (containsToolAdmissionMarker(text)) return { text, spilled: false };
	const capTokens = resolveToolResultAdmissionCapTokens(contextWindow);
	const totalTokens = estimateTextTokens(text);
	if (totalTokens <= capTokens) return { text, spilled: false };

	const spillPath = spillToFile(spillDir, text);
	const charsPerToken = text.length / Math.max(1, totalTokens);
	let budgetChars = Math.floor(capTokens * charsPerToken);
	let excerpt = buildExcerpt(text, budgetChars, totalTokens, spillPath);
	for (let pass = 0; pass < MAX_SHRINK_PASSES && estimateTextTokens(excerpt) > capTokens; pass++) {
		budgetChars = Math.floor(budgetChars * 0.8);
		excerpt = buildExcerpt(text, budgetChars, totalTokens, spillPath);
	}

	return { text: excerpt, spilled: true, spillPath };
}
