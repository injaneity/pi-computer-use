import { closeSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export const MODEL_TEXT_MAX_BYTES = 48 * 1024;
export const MODEL_TEXT_MAX_LINES = 2_000;
export const OUTPUT_PAGE_BYTES = 16 * 1024;
export const UI_TEXT_PAGE_CHARS = 12 * 1024;
export const MODEL_PREVIEW_BYTES = 16 * 1024;
const OUTPUT_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
const OUTPUT_STORE_MAX_BYTES = 64 * 1024 * 1024;

interface StoredOutput {
	ref: string;
	filePath: string;
	storedBytes: number;
	totalBytes: number;
	complete: boolean;
}

const outputs = new Map<string, StoredOutput>();
let outputDirectory: string | undefined;
let outputBytes = 0;
let nextOutputId = 1;

function utf8Prefix(bytes: Uint8Array, maxBytes: number): Uint8Array {
	if (bytes.byteLength <= maxBytes) return bytes;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end);
}

function boundedPrefix(value: string, maxBytes: number, maxLines: number): string {
	const lines = value.split("\n", maxLines + 1);
	const lineBounded = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : value;
	return new TextDecoder().decode(utf8Prefix(new TextEncoder().encode(lineBounded), maxBytes));
}

function storeOutput(value: string): StoredOutput {
	const encoded = new TextEncoder().encode(value);
	const stored = encoded.byteLength > OUTPUT_ENTRY_MAX_BYTES ? utf8Prefix(encoded, OUTPUT_ENTRY_MAX_BYTES) : encoded;
	outputDirectory ??= mkdtempSync(path.join(os.tmpdir(), "pi-computer-use-output-"));
	const ref = `@o${nextOutputId++}`;
	const filePath = path.join(outputDirectory, `${ref.slice(2)}.txt`);
	writeFileSync(filePath, stored, { mode: 0o600 });
	const entry: StoredOutput = { ref, filePath, storedBytes: stored.byteLength, totalBytes: encoded.byteLength, complete: stored.byteLength === encoded.byteLength };
	outputs.set(entry.ref, entry);
	outputBytes += entry.storedBytes;
	while (outputBytes > OUTPUT_STORE_MAX_BYTES && outputs.size > 1) {
		const oldestRef = outputs.keys().next().value as string | undefined;
		if (!oldestRef) break;
		const oldest = outputs.get(oldestRef)!;
		outputs.delete(oldestRef);
		outputBytes -= oldest.storedBytes;
		try { unlinkSync(oldest.filePath); } catch { /* already removed */ }
	}
	return entry;
}

function refinementFor(tool: string): string {
	if (tool === "search_ui") return "use a more selective text, role, or capability predicate";
	if (tool === "find_roots") return "use a more selective text, app, bundleId, pid, or kind filter";
	if (tool === "evaluate_browser") return "return selected fields, an aggregate, or a smaller slice";
	if (tool === "observe_ui" || tool === "expand_ui") return "use search_ui or expand a more specific ref";
	return "request a smaller or more focused result";
}

export function applyOutputEnvelope<T>(tool: string, result: AgentToolResult<T>): AgentToolResult<T> {
	const textParts = result.content.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text");
	const combined = textParts.map((part) => part.text).join("\n");
	const bytes = new TextEncoder().encode(combined).byteLength;
	const lines = combined === "" ? 0 : combined.split("\n").length;
	if (bytes <= MODEL_TEXT_MAX_BYTES && lines <= MODEL_TEXT_MAX_LINES) return result;

	const entry = storeOutput(combined);
	const preview = boundedPrefix(combined, MODEL_PREVIEW_BYTES, MODEL_TEXT_MAX_LINES - 4);
	const returnedBytes = new TextEncoder().encode(preview).byteLength;
	const availability = entry.complete
		? `continue: read_text({ ref: "${entry.ref}", offset: ${returnedBytes} })`
		: `continue: read_text({ ref: "${entry.ref}", offset: ${returnedBytes} }); only the first ${entry.storedBytes} bytes were stored, so refine for the remainder`;
	const trailer = [
		`output truncated: returned ${returnedBytes} of ${entry.totalBytes} utf-8 bytes`,
		`refine: ${refinementFor(tool)}`,
		availability,
	].join("\n");
	const images = result.content.filter((part) => part.type === "image");
	return { ...result, content: [{ type: "text", text: `${preview}\n\n${trailer}` }, ...images] };
}

export function boundToolError(tool: string, error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	const bytes = new TextEncoder().encode(message).byteLength;
	const lines = message.split("\n").length;
	if (bytes <= MODEL_TEXT_MAX_BYTES && lines <= MODEL_TEXT_MAX_LINES) return error instanceof Error ? error : new Error(message);
	const entry = storeOutput(message);
	const preview = boundedPrefix(message, MODEL_PREVIEW_BYTES, MODEL_TEXT_MAX_LINES - 4);
	const returnedBytes = new TextEncoder().encode(preview).byteLength;
	const storageNote = entry.complete ? "" : `; only the first ${entry.storedBytes} bytes were stored`;
	return new Error(`${preview}\n\nerror truncated: returned ${returnedBytes} of ${entry.totalBytes} utf-8 bytes\nrefine: ${refinementFor(tool)}\ncontinue: read_text({ ref: "${entry.ref}", offset: ${returnedBytes} })${storageNote}`);
}

export function readStoredOutput(ref: string, offsetValue: unknown): { text: string; offset: number; limit: number; totalBytes: number; hasMore: boolean; complete: boolean } | undefined {
	const entry = outputs.get(ref);
	if (!entry) return undefined;
	let offset = Math.min(entry.storedBytes, Math.max(0, Math.trunc(typeof offsetValue === "number" && Number.isFinite(offsetValue) ? offsetValue : 0)));
	const requestedBytes = Math.min(entry.storedBytes - offset, OUTPUT_PAGE_BYTES + 4);
	const buffer = new Uint8Array(Math.max(0, requestedBytes));
	const fd = openSync(entry.filePath, "r");
	try { if (buffer.byteLength > 0) readSync(fd, buffer, 0, buffer.byteLength, offset); } finally { closeSync(fd); }
	let start = 0;
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1;
	offset += start;
	const slice = utf8Prefix(buffer.subarray(start), OUTPUT_PAGE_BYTES);
	const actualEnd = offset + slice.byteLength;
	return {
		text: new TextDecoder().decode(slice),
		offset,
		limit: slice.byteLength,
		totalBytes: entry.totalBytes,
		hasMore: actualEnd < entry.storedBytes,
		complete: entry.complete,
	};
}

export function clearStoredOutputs(): void {
	outputs.clear();
	if (outputDirectory) {
		try { rmSync(outputDirectory, { recursive: true, force: true }); } catch { /* best-effort session cleanup */ }
	}
	outputDirectory = undefined;
	outputBytes = 0;
	nextOutputId = 1;
}
