import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	ModelSwitchOptions as ExtensionsModelSwitchOptions,
	SessionModelPolicy as ExtensionsSessionModelPolicy,
} from "../../src/core/extensions/index.ts";
import type { ModelSwitchOptions, SessionModelPolicy } from "../../src/index.ts";

describe("public model policy contract", () => {
	it("exports SessionModelPolicy and ModelSwitchOptions from both intended barrels", () => {
		// #given a configured declaration written against the package root barrel
		const declaration: SessionModelPolicy = { models: [{ model: "faux/primary", thinkingLevel: "medium" }] };
		const options: ModelSwitchOptions = {};
		// #then the extensions barrel resolves to the identical types, so SDK and
		// extension authors cannot end up with two structurally divergent contracts.
		expectTypeOf<SessionModelPolicy>().toEqualTypeOf<ExtensionsSessionModelPolicy>();
		expectTypeOf<ModelSwitchOptions>().toEqualTypeOf<ExtensionsModelSwitchOptions>();
		const mirrored: ExtensionsSessionModelPolicy = declaration;
		const mirroredOptions: ExtensionsModelSwitchOptions = options;
		expect(mirrored.models[0]?.model).toBe("faux/primary");
		expect(mirroredOptions).toEqual({});
	});
});
