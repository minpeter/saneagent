import assert from "node:assert/strict";
import { it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("submits /model policy literally while command-name autocomplete is still active", { timeout: 2000 }, async () => {
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const editor = new Editor(tui, defaultEditorTheme);
	let rendered!: () => void;
	const ready = new Promise<void>((resolve) => {
		rendered = resolve;
	});
	tui.requestRender = () => {
		rendered();
	};
	const provider = new CombinedAutocompleteProvider(
		[{ name: "model", description: "Select model", getArgumentCompletions: () => null }],
		process.cwd(),
	);
	let completions = 0;
	const apply = provider.applyCompletion.bind(provider);
	provider.applyCompletion = (...args) => {
		completions++;
		return apply(...args);
	};
	editor.setAutocompleteProvider(provider);
	let submitted: string | undefined;
	editor.onSubmit = (text) => {
		submitted = text;
	};
	editor.handleInput("/model");
	await ready;
	assert.equal(editor.isShowingAutocomplete(), true);
	// A terminal input chunk can include the argument and Enter before a new
	// asynchronous autocomplete request replaces the command-name menu.
	editor.handleInput(" policy");
	assert.equal(editor.isShowingAutocomplete(), true);
	editor.handleInput("\r");
	assert.equal(submitted, "/model policy");
	assert.equal(completions, 0);
});

for (const [input, value, submitted] of [
	["/mod", "/model", "/model"],
	["/model fix", "/model local/fixture", undefined],
] as const) {
	it(`preserves autocomplete for ${input}`, { timeout: 2000 }, async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		let rendered!: () => void;
		const ready = new Promise<void>((resolve) => {
			rendered = resolve;
		});
		tui.requestRender = () => {
			rendered();
		};
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{
						name: "model",
						getArgumentCompletions: () => [{ value: "local/fixture", label: "local/fixture" }],
					},
				],
				process.cwd(),
			),
		);
		let actual: string | undefined;
		editor.onSubmit = (text) => {
			actual = text;
		};
		editor.handleInput(input);
		await ready;
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\r");
		assert.equal(actual, submitted);
		assert.equal((actual ?? editor.getText()).trim(), value);
	});
}
