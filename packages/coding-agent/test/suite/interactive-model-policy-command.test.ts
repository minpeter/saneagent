import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

/**
 * The /model surface for the policy-return action. Exercises the real InteractiveMode methods so the
 * notification contract is proven, not assumed: a failing return must reach showError and must not
 * escape as an unhandled rejection into the TUI.
 */
describe("InteractiveMode /model policy routing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function callFollow(fakeThis: unknown): Promise<void> {
		const fn = Reflect.get(InteractiveMode.prototype, "followModelPolicyFromUi");
		if (typeof fn !== "function") throw new Error("InteractiveMode.followModelPolicyFromUi is missing");
		return fn.call(fakeThis) as Promise<void>;
	}

	function callHandle(fakeThis: unknown, term?: string): Promise<void> {
		const fn = Reflect.get(InteractiveMode.prototype, "handleModelCommand");
		if (typeof fn !== "function") throw new Error("InteractiveMode.handleModelCommand is missing");
		return fn.call(fakeThis, term) as Promise<void>;
	}

	it("#given the return succeeds #when /model policy runs #then it reports the policy status", async () => {
		const followModelPolicy = vi.fn(async () => undefined);
		const fakeThis = {
			session: { followModelPolicy, model: { id: "faux-2" }, hasModelPolicy: true },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		await callFollow(fakeThis);
		expect(followModelPolicy).toHaveBeenCalledOnce();
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledOnce();
		expect(String(fakeThis.showStatus.mock.calls[0]?.[0])).toContain("following configured policy");
	});

	it("#given the return rejects #when /model policy runs #then it notifies instead of throwing", async () => {
		const message = "No configured authentication for any model in the session policy";
		const followModelPolicy = vi.fn(async () => {
			throw new Error(message);
		});
		const fakeThis = {
			session: { followModelPolicy, model: { id: "faux-3" }, hasModelPolicy: true },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		// Must resolve: an unhandled rejection here would surface as a crash in the TUI.
		await expect(callFollow(fakeThis)).resolves.toBeUndefined();
		expect(fakeThis.showError).toHaveBeenCalledExactlyOnceWith(message);
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});

	it("#given no policy #when /model policy runs #then it reports and never opens the selector", async () => {
		const fakeThis = {
			session: { followModelPolicy: vi.fn(), hasModelPolicy: false, scopedModels: [] },
			showModelSelector: vi.fn(),
			showError: vi.fn(),
			findExactModelMatch: vi.fn(),
			selectModelFromUi: vi.fn(),
		};
		await callHandle(fakeThis, "policy");
		expect(fakeThis.showError).toHaveBeenCalledOnce();
		expect(fakeThis.showModelSelector).not.toHaveBeenCalled();
		expect(fakeThis.findExactModelMatch).not.toHaveBeenCalled();
		expect(fakeThis.session.followModelPolicy).not.toHaveBeenCalled();
	});

	it("#given a model reference #when /model runs #then the policy action is not triggered", async () => {
		const followModelPolicy = vi.fn();
		const fakeThis = {
			session: { followModelPolicy, hasModelPolicy: true, scopedModels: [] },
			showModelSelector: vi.fn(),
			showError: vi.fn(),
			findExactModelMatch: vi.fn(async () => undefined),
			selectModelFromUi: vi.fn(),
		};
		await callHandle(fakeThis, "policy-tuned-v2");
		expect(followModelPolicy).not.toHaveBeenCalled();
		expect(fakeThis.findExactModelMatch).toHaveBeenCalledExactlyOnceWith("policy-tuned-v2");
		expect(fakeThis.showModelSelector).toHaveBeenCalledExactlyOnceWith("policy-tuned-v2");
	});
});
