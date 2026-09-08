import { describe, expect, it } from "vitest";
import { resolveModelCommandAction } from "../../src/core/model-command-action.ts";

/**
 * The /model argument decision. Extracted from the TUI so the routing is testable: the interactive
 * mode owns painting and notification, this owns WHICH action an argument means.
 */
describe("model command action", () => {
	it("#given the policy term #when a policy is configured #then it routes to the return action", () => {
		expect(resolveModelCommandAction("configured", { hasConfiguredModel: true })).toEqual({ kind: "follow-configured" });
		// Case and surrounding whitespace are how people actually type it.
		expect(resolveModelCommandAction("  Configured  ", { hasConfiguredModel: true })).toEqual({ kind: "follow-configured" });
	});

	it("#given the policy term #when no policy is configured #then it reports instead of searching", () => {
		expect(resolveModelCommandAction("configured", { hasConfiguredModel: false })).toEqual({
			kind: "error",
			message: "No configured model is available for this session.",
		});
	});

	it("#given no argument #when resolving #then it opens the selector", () => {
		expect(resolveModelCommandAction(undefined, { hasConfiguredModel: true })).toEqual({ kind: "open-selector" });
		expect(resolveModelCommandAction("", { hasConfiguredModel: true })).toEqual({ kind: "open-selector" });
	});

	it("#given a model reference #when resolving #then it stays a model search", () => {
		expect(resolveModelCommandAction("faux/faux-1", { hasConfiguredModel: true })).toEqual({
			kind: "search",
			searchTerm: "faux/faux-1",
		});
		expect(resolveModelCommandAction("policy", { hasConfiguredModel: true })).toEqual({
			kind: "search",
			searchTerm: "policy",
		});
		// A model whose name merely contains the term must not be hijacked.
		expect(resolveModelCommandAction("policy-tuned-v2", { hasConfiguredModel: true })).toEqual({
			kind: "search",
			searchTerm: "policy-tuned-v2",
		});
	});
});
