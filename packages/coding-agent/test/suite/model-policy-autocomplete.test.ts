import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

const models = [
	{ id: "gemini-configured-preview", provider: "google", name: "Gemini configured preview" },
	{ id: "primary", provider: "local", name: "Primary" },
];

function createProvider(hasConfiguredModel: boolean, catalog = models, scoped = false) {
	const host = {
		session: {
			hasConfiguredModel,
			scopedModels: scoped ? catalog.map((model) => ({ model })) : [],
			modelRuntime: { getAvailableSnapshot: vi.fn(() => catalog) },
			promptTemplates: [],
			extensionRunner: { getRegisteredCommands: () => [] },
			resourceLoader: { getSkills: () => ({ skills: [] }) },
		},
		settingsManager: { getEnableSkillCommands: () => false },
		skillCommands: new Map(),
		sessionManager: { getCwd: () => "/tmp" },
		fdPath: null,
		followConfiguredModelFromUi: vi.fn(async () => undefined),
		findExactModelMatch: vi.fn(),
		showModelSelector: vi.fn(),
	};
	Object.setPrototypeOf(host, InteractiveMode.prototype);
	const provider = Reflect.apply(
		Reflect.get(InteractiveMode.prototype, "createBaseAutocompleteProvider"),
		host,
		[],
	) as AutocompleteProvider;
	const suggestions = (line: string) =>
		provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	return { host, provider, suggestions };
}

describe("main editor configured model autocomplete", () => {
	it.each([false, true])(
		"recommends the action ahead of matching models (scoped=%s) and routes its value",
		async (scoped) => {
			const { host, provider, suggestions } = createProvider(true, models, scoped);
			const line = "/model configured";
			const result = await suggestions(line);
			expect(result?.items[0]?.value).toBe("configured");
			expect(result?.items.map((item) => item.value)).toContain("google/gemini-configured-preview");
			if (!result) throw new Error("Missing argument completions");
			const completion = provider.applyCompletion([line], 0, line.length, result.items[0], result.prefix);
			expect(completion.lines).toEqual(["/model configured"]);
			await Reflect.apply(Reflect.get(InteractiveMode.prototype, "handleModelCommand"), host, [
				completion.lines[0].slice("/model ".length),
			]);
			expect(host.followConfiguredModelFromUi).toHaveBeenCalledOnce();
			expect(host.findExactModelMatch).not.toHaveBeenCalled();
			expect(host.showModelSelector).not.toHaveBeenCalled();
		},
	);

	it("offers policy with an empty model catalog", async () => {
		const { suggestions } = createProvider(true, []);
		expect((await suggestions("/model conf"))?.items.map((item) => item.value)).toEqual(["configured"]);
	});

	it("omits the action without a configured policy, including an empty catalog", async () => {
		const { suggestions } = createProvider(false);
		expect((await suggestions("/model configured"))?.items.map((item) => item.value)).not.toContain("configured");
		expect(await createProvider(false, []).suggestions("/model configured")).toBeNull();
	});

	it("preserves model completions and checks current policy availability", async () => {
		const { host, suggestions } = createProvider(true);
		expect((await suggestions("/model local/pri"))?.items.map((item) => item.value)).toEqual(["local/primary"]);
		expect((await suggestions("/model "))?.items.map((item) => item.value)).toEqual([
			"configured",
			...models.map((model) => `${model.provider}/${model.id}`),
		]);
		host.session.hasConfiguredModel = false;
		expect((await suggestions("/model configured"))?.items.map((item) => item.value)).not.toContain("configured");
		expect(await suggestions("/model nonexistent-xyz")).toBeNull();
	});
});
