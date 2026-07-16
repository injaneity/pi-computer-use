import assert from "node:assert/strict";
import { applyOutputEnvelope, boundToolError, clearStoredOutputs, MODEL_TEXT_MAX_BYTES, readStoredOutput } from "../src/output.ts";
import { searchOutlineRanked } from "../src/outline.ts";

clearStoredOutputs();
const oversized = "🙂".repeat(30_000);
const bounded = applyOutputEnvelope("evaluate_browser", { content: [{ type: "text", text: oversized }], details: {} });
const visible = bounded.content[0].text;
assert.ok(Buffer.byteLength(visible, "utf8") <= MODEL_TEXT_MAX_BYTES, "model-facing text exceeds the hard ceiling");
const ref = visible.match(/"(@o\d+)"/)?.[1];
const offset = Number(visible.match(/offset: (\d+)/)?.[1]);
assert.ok(ref && Number.isFinite(offset), "truncated output must provide a continuation");
const page = readStoredOutput(ref, offset);
assert.ok(page?.text.length, "continuation page must exist");
assert.equal(readStoredOutput(ref, offset)?.text, page.text, "continuation pages must be immutable");
assert.doesNotThrow(() => new TextEncoder().encode(page.text), "continuation must preserve utf-8");
const unaligned = readStoredOutput(ref, offset + 1);
assert.ok(unaligned && !unaligned.text.startsWith("�"), "arbitrary offsets must align to utf-8 boundaries");
const lineBounded = applyOutputEnvelope("observe_ui", { content: [{ type: "text", text: "x\n".repeat(3_000) }], details: {} });
assert.ok(lineBounded.content[0].text.split("\n").length <= 2_000, "model-facing text exceeds the line ceiling");
const boundedError = boundToolError("evaluate_browser", new Error("x".repeat(100_000)));
assert.ok(Buffer.byteLength(boundedError.message, "utf8") <= MODEL_TEXT_MAX_BYTES, "tool errors must obey the text ceiling");

const node = (ref, title, role = "AXButton") => ({ ref, role, subrole: "", identifier: "", title, description: "", value: "", actions: ["AXPress"], canPress: true, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [] });
const root = node("@e1", "root", "AXWindow");
root.children = [node("@e2", "Save"), node("@e3", "Save changes"), node("@e4", "Autosave"), node("@e5", "Svae")];
for (const child of root.children) child.parent = root;
const outline = { lookId: "look", root, nodes: [root, ...root.children], refToWireRef: new Map(), wireRefToRef: new Map() };
const ranked = searchOutlineRanked(outline, "save", "button", "press", 12);
assert.deepEqual(ranked.matches.map((match) => match.matchReason), ["exact", "prefix", "substring", "fuzzy"]);
assert.equal(ranked.totalMatches, 4);
clearStoredOutputs();

console.log("Bounded output and ranked search checks passed.");
