import assert from "node:assert/strict";
import { normalizeFindParams } from "../src/find-params.ts";

assert.deepEqual(normalizeFindParams(undefined), {
	text: undefined,
	app: undefined,
	bundleId: undefined,
	pid: undefined,
	kind: undefined,
});

assert.deepEqual(
	normalizeFindParams({
		text: "  editor  ",
		app: "  TextEdit  ",
		bundleId: "  com.apple.TextEdit  ",
		pid: 42,
		kind: "window",
	}),
	{
		text: "editor",
		app: "TextEdit",
		bundleId: "com.apple.TextEdit",
		pid: 42,
		kind: "window",
	},
);

for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
	assert.throws(
		() => normalizeFindParams({ pid }),
		/find_roots\.pid must be a positive integer when provided\./,
		`expected pid ${pid} to be rejected`,
	);
}

console.log("Find parameter checks passed.");
