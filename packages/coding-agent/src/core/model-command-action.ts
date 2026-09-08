/**
 * What a `/model <arg>` invocation means.
 *
 * The interactive mode owns painting and notification; this owns the routing decision, so the
 * behaviour is testable without a terminal. The policy term is matched on the whole argument only:
 * a model literally named something like "policy-tuned-v2" must stay a model search.
 */
export type ModelCommandAction =
	| { kind: "open-selector" }
	| { kind: "follow-policy" }
	| { kind: "search"; searchTerm: string }
	| { kind: "error"; message: string };

/** The word a user types to hand the MAIN slot back to the configured chain. */
export const MODEL_POLICY_COMMAND_TERM = "policy";

export const NO_MODEL_POLICY_MESSAGE = "No model policy is configured for this session.";

export function resolveModelCommandAction(
	searchTerm: string | undefined,
	context: { readonly hasPolicy: boolean },
): ModelCommandAction {
	const trimmed = searchTerm?.trim() ?? "";
	if (trimmed.length === 0) return { kind: "open-selector" };
	if (trimmed.toLowerCase() === MODEL_POLICY_COMMAND_TERM) {
		// Reporting beats silently searching for a model called "policy": the user asked for a
		// feature that is not configured, and a model-not-found message would not explain that.
		return context.hasPolicy ? { kind: "follow-policy" } : { kind: "error", message: NO_MODEL_POLICY_MESSAGE };
	}
	return { kind: "search", searchTerm: trimmed };
}
