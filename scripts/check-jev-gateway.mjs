// One live Vercel AI Gateway evaluation through the jev decision backend.
// Gated by PI_CU_LIVE_GATEWAY=1 because it spends Gateway credits and sends the
// synthetic state below to Vercel. Never part of `npm test`.
import assert from "node:assert/strict";
import { loadComputerUseConfig } from "../src/config.ts";
import { chooseJevAction, describeJevDecisionProvider, loadJevDecisionProvider } from "../src/jev/policy.ts";
import { buildJevSpace } from "../src/jev/space.ts";

if (process.env.PI_CU_LIVE_GATEWAY !== "1") {
	console.log("SKIP live Gateway evaluation (set PI_CU_LIVE_GATEWAY=1)");
	process.exit(0);
}

const page = {
	url: "https://example.test/flights",
	title: "Flight search",
	text: "Search one-way flights. Origin, destination, and departure date.",
	scroll: { y: 0, height: 800 },
	actions: [
		{ id: "e1", kind: "fill", label: "Where from?", role: "combobox", value: "", node: 10 },
		{ id: "e2", kind: "click", label: "Open Where from?", role: "combobox", value: "", node: 10 },
		{ id: "e3", kind: "fill", label: "Where to?", role: "combobox", value: "", node: 20 },
		{ id: "e4", kind: "click", label: "Open Where to?", role: "combobox", value: "", node: 20 },
		{ id: "e5", kind: "click", label: "Search", role: "button", value: "", node: 30 },
		{ id: "wait", kind: "wait", label: "Wait for the page to update" },
	],
	marker: null,
	page_key: null,
	guards: {},
	omitted_actions: 0,
};
const space = buildJevSpace(page.actions);

loadComputerUseConfig(process.cwd());
const provider = loadJevDecisionProvider();
assert.ok(provider, "no jev decision provider resolved; set a Gateway credential");
assert.ok(!("missingModule" in provider && provider.missingModule), `missing optional package: ${provider.missingModule}`);
assert.notEqual(provider.backend, "typesafe", "this check exercises the Vercel AI SDK backend");

const started = Date.now();
const decision = await chooseJevAction(page, space, "Search for a one-way flight from Zurich to London", [], provider);
const offered = new Set(page.actions.map((action) => action.id));
assert.ok(offered.has(decision.actionId), `decision action '${decision.actionId}' is not an offered action`);

console.log(JSON.stringify({
	provider: describeJevDecisionProvider(),
	backend: provider.backend,
	model: decision.model,
	operation: decision.operation,
	target: decision.target,
	actionId: decision.actionId,
	confidence: decision.confidence,
	targetConfidence: decision.targetConfidence,
	probabilities: decision.probabilities,
	usage: decision.usage,
	latencyMs: decision.latencyMs,
	wallMs: Date.now() - started,
}, null, 2));
console.log("PASS: one live Vercel AI Gateway jev decision; the action maps to an offered code-owned id");
