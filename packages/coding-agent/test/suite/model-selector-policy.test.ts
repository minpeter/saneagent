import { Container, setKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("configured policy picker action", () => {
	let harness: Harness;
	let selector: ModelSelectorComponent | undefined;
	const text = () => stripAnsi(selector?.render(100).join("\n") ?? "");
	beforeAll(() => initTheme("dark"));
	beforeEach(async () => {
		setKeybindings(new KeybindingsManager());
		harness = await createHarness({
			models: [
				{ id: "primary", reasoning: true },
				{ id: "manual", reasoning: true },
			],
		});
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() => harness.models);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
	});
	afterEach(() => {
		selector?.dispose();
		selector = undefined;
		harness.cleanup();
		vi.restoreAllMocks();
	});

	function open(onFollowPolicy?: () => void, scoped = false, policyOwned = false) {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const onFavoriteChange = vi.fn();
		const options = { onFollowPolicy, onFavoriteChange, favoriteModelIds: [], policyOwned };
		selector = new ModelSelectorComponent(
			{ requestRender: vi.fn(), terminal: { rows: 24 } },
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			scoped ? [{ model: harness.getModel() }] : [],
			onSelect,
			onCancel,
			undefined,
			options,
		);
		return { onSelect, onCancel, onFavoriteChange };
	}

	it.each(["policy", "manual-other", "manual-same-primary", "unconfigured"] as const)(
		"#given %s ownership #when the real UI opens its picker #then the rendered initial arrow reflects ownership",
		async (ownership) => {
			const primary = harness.getModel();
			if (ownership !== "unconfigured") {
				await harness.session.setModelPolicy({ models: [{ model: `${primary.provider}/${primary.id}` }] });
				await harness.session.followModelPolicy();
			}
			if (ownership === "manual-other" || ownership === "manual-same-primary") {
				const manual = ownership === "manual-other" ? harness.getModel("manual") : primary;
				if (!manual) throw new Error("fixture model missing");
				await harness.session.setModel(manual);
			}
			const editorContainer = new Container();
			const host = {
				session: harness.session,
				settingsManager: harness.settingsManager,
				editor: new Text("editor"),
				editorContainer,
				ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			};
			Object.setPrototypeOf(host, InteractiveMode.prototype);
			const saveDefault = vi.spyOn(harness.settingsManager, "setDefaultModelAndProvider");
			Reflect.apply(Reflect.get(InteractiveMode.prototype, "showModelSelector"), host, []);
			const component = editorContainer.children[0];
			if (!(component instanceof ModelSelectorComponent)) throw new Error("real picker missing");
			selector = component;
			const selectedRows = text()
				.split("\n")
				.filter((line) => line.startsWith("→ "));
			expect(selectedRows).toHaveLength(1);
			if (ownership === "policy") {
				expect(selectedRows[0]).not.toContain(`[${primary.provider}]`);
			} else {
				expect(selectedRows[0]).toContain(`${harness.session.model?.id} [${primary.provider}]`);
			}
			expect(saveDefault).not.toHaveBeenCalled();
		},
	);

	it.each(["refresh", "scope"] as const)(
		"#given policy focus #when %s changes the catalog #then initial policy focus survives",
		async (change) => {
			const refresh = Promise.withResolvers<{ aborted: boolean; errors: Map<string, Error> }>();
			vi.mocked(harness.session.modelRuntime.refresh).mockReturnValue(refresh.promise);
			const tui = { requestRender: vi.fn() };
			const onFollowPolicy = vi.fn();
			const onSelect = vi.fn();
			selector = new ModelSelectorComponent(
				tui,
				harness.getModel(),
				harness.settingsManager,
				harness.session.modelRuntime,
				// Scope order differs from the all-catalog current-first order.
				harness.models.toReversed().map((model) => ({ model })),
				onSelect,
				vi.fn(),
				undefined,
				{ onFollowPolicy, policyOwned: true },
			);
			const selectedRow = () =>
				text()
					.split("\n")
					.find((line) => line.startsWith("→ "));
			const policyRow = selectedRow();
			expect(policyRow).toBeDefined();
			expect(policyRow).not.toContain(`[${harness.getModel().provider}]`);
			if (change === "refresh") {
				const completed = Promise.withResolvers<void>();
				tui.requestRender.mockImplementation(completed.resolve);
				refresh.resolve({ aborted: false, errors: new Map() });
				await completed.promise;
			} else {
				selector.handleInput("\t");
			}
			expect(selectedRow()).toBe(policyRow);
			selector.handleInput("\r");
			expect(onFollowPolicy).toHaveBeenCalledOnce();
			expect(onSelect).not.toHaveBeenCalled();
		},
		5_000,
	);

	it.each([
		["refresh", "\x1b[B"],
		["refresh", "\x1b[A"],
		["scope", "\x1b[B"],
		["scope", "\x1b[A"],
	] as const)(
		"#given explicit arrow navigation before %s (%j) #when the catalog changes #then the same model row stays selected",
		async (change, arrow) => {
			const refresh = Promise.withResolvers<{ aborted: boolean; errors: Map<string, Error> }>();
			vi.mocked(harness.session.modelRuntime.refresh).mockReturnValue(refresh.promise);
			const tui = { requestRender: vi.fn() };
			const onSelect = vi.fn();
			const onFollowPolicy = vi.fn();
			selector = new ModelSelectorComponent(
				tui,
				harness.getModel(),
				harness.settingsManager,
				harness.session.modelRuntime,
				harness.models.toReversed().map((model) => ({ model })),
				onSelect,
				vi.fn(),
				undefined,
				{ onFollowPolicy, policyOwned: true },
			);
			selector.handleInput(arrow);
			const expectedModel = arrow === "\x1b[B" ? harness.getModel("manual") : harness.getModel();
			const selectedRow = () =>
				text()
					.split("\n")
					.find((line) => line.startsWith("→ "));
			expect(selectedRow()).toContain(`${expectedModel?.id} [${expectedModel?.provider}]`);
			if (change === "refresh") {
				const completed = Promise.withResolvers<void>();
				tui.requestRender.mockImplementation(completed.resolve);
				refresh.resolve({ aborted: false, errors: new Map() });
				await completed.promise;
			} else {
				selector.handleInput("\t");
			}
			expect(selectedRow()).toContain(`${expectedModel?.id} [${expectedModel?.provider}]`);
			selector.handleInput("\r");
			expect(onSelect).toHaveBeenCalledExactlyOnceWith(expectedModel);
			expect(onFollowPolicy).not.toHaveBeenCalled();
		},
		5_000,
	);

	it("#given a policy #when searching and selecting its action #then no model default or favorite is written", () => {
		const onFollowPolicy = vi.fn();
		const { onSelect, onFavoriteChange } = open(onFollowPolicy);
		const saveDefault = vi.spyOn(harness.settingsManager, "setDefaultModelAndProvider");
		selector?.handleInput("policy");
		expect(text()).toMatch(/^→ {3}\S[^\n]*$/m);
		selector?.handleInput("\x06");
		selector?.handleInput("\r");
		expect(onFollowPolicy).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
		expect(onFavoriteChange).not.toHaveBeenCalled();
		expect(saveDefault).not.toHaveBeenCalled();
	});

	it("#given policy owns the current model #when the picker renders #then policy owns the checkmark", () => {
		open(vi.fn(), false, true);
		expect(text()).toMatch(/^→ {3}\S[^\n]* ✓[^\S\n]*$/m);
		expect(text().match(/✓/g)).toHaveLength(1);
		expect(text()).not.toContain("primary [faux] ✓");
	});

	it("#given a manual override #when the picker renders #then the model owns the checkmark", () => {
		open(vi.fn(), false, false);
		expect(text().match(/✓/g)).toHaveLength(1);
		expect(text()).toContain("primary [faux] ✓");
	});

	it("#given no policy #when searching policy #then no action is available", () => {
		const { onSelect } = open();
		selector?.handleInput("policy");
		selector?.handleInput("\r");
		expect(text()).not.toMatch(/^→ /m);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("#given a current model #when navigating up #then the action is selectable and wraps back to models", () => {
		const onFollowPolicy = vi.fn();
		const { onSelect } = open(onFollowPolicy);
		selector?.handleInput("\x1b[A");
		expect(text()).toMatch(/^→ {3}\S[^\n]*$/m);
		selector?.handleInput("\x1b[A");
		selector?.handleInput("\r");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(harness.getModel("manual"));
		expect(onFollowPolicy).not.toHaveBeenCalled();
	});

	it("#given a narrowed catalog #when switching scope with a policy search #then the action remains selectable", () => {
		const onFollowPolicy = vi.fn();
		open(onFollowPolicy, true);
		selector?.handleInput("policy");
		selector?.handleInput("\t");
		selector?.handleInput("\r");
		expect(onFollowPolicy).toHaveBeenCalledOnce();
	});

	it("#given an in-flight catalog refresh #when it finishes #then the searched action survives", async () => {
		const refresh = Promise.withResolvers<{ aborted: boolean; errors: Map<string, Error> }>();
		vi.mocked(harness.session.modelRuntime.refresh).mockReturnValue(refresh.promise);
		const tui = { requestRender: vi.fn() };
		const onFollowPolicy = vi.fn();
		const options = { onFollowPolicy };
		selector = new ModelSelectorComponent(
			tui,
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			vi.fn(),
			vi.fn(),
			"policy",
			options,
		);
		// Subscribe to the post-refresh render, not the constructor's initial render.
		const completed = Promise.withResolvers<void>();
		tui.requestRender.mockImplementation(completed.resolve);
		refresh.resolve({ aborted: false, errors: new Map() });
		await completed.promise;
		selector.handleInput("\r");
		expect(onFollowPolicy).toHaveBeenCalledOnce();
	}, 5_000);

	it.each([40, 80, 120])(
		"#given width %i #when rendering the action #then it stays within terminal columns",
		(width) => {
			open(vi.fn());
			selector?.handleInput("policy");
			expect(text()).toMatch(/^→ {3}\S[^\n]*$/m);
			for (const line of selector?.render(width) ?? []) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		},
	);

	it("#given a policy action #when cancelling #then it does not follow policy", () => {
		const onFollowPolicy = vi.fn();
		const { onCancel } = open(onFollowPolicy);
		selector?.handleInput("policy");
		selector?.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onFollowPolicy).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"#given policy configured=%s #when the real UI opens its picker #then Enter returns ownership only when configured",
		async (configured) => {
			const primary = harness.getModel();
			if (configured)
				await harness.session.setModelPolicy({
					models: [{ model: `${primary.provider}/${primary.id}`, thinkingLevel: "high" }],
				});
			const manual = harness.getModel("manual");
			if (!manual) throw new Error("fixture model missing");
			await harness.session.setModel(manual);
			const editor = new Text("editor");
			const editorContainer = new Container();
			const status = Promise.withResolvers<void>();
			const ui = { requestRender: vi.fn(), setFocus: vi.fn() };
			const host = {
				session: harness.session,
				settingsManager: harness.settingsManager,
				editor,
				editorContainer,
				ui,
				footer: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				showStatus: vi.fn(() => status.resolve()),
				showError: vi.fn(),
			};
			Object.setPrototypeOf(host, InteractiveMode.prototype);
			const follow = vi.spyOn(harness.session, "followModelPolicy");
			const saveDefault = vi.spyOn(harness.settingsManager, "setDefaultModelAndProvider");
			Reflect.apply(Reflect.get(InteractiveMode.prototype, "showModelSelector"), host, []);
			const component = editorContainer.children[0];
			if (!(component instanceof ModelSelectorComponent)) throw new Error("real picker missing");
			selector = component;
			component.handleInput("policy");
			component.handleInput("\r");
			if (configured) {
				expect(follow).toHaveBeenCalledOnce();
				expect(editorContainer.children).toEqual([editor]);
				expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
				await status.promise;
				expect(harness.session.model?.id).toBe(primary.id);
				expect(harness.session.thinkingLevel).toBe("high");
				expect(host.showError).not.toHaveBeenCalled();
			} else {
				expect(follow).not.toHaveBeenCalled();
				expect(editorContainer.children).toEqual([component]);
			}
			expect(saveDefault).not.toHaveBeenCalled();
		},
		5_000,
	);
});
