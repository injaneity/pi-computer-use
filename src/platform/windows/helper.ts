import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");
const HELPER_SETUP_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;

export const WINDOWS_HELPER_PROTOCOL_VERSION = 4;
export const WINDOWS_HELPER_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");

interface Pending<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

async function isExecutable(filePath: string): Promise<boolean> {
	try { await access(filePath, fsConstants.X_OK); return true; } catch { return false; }
}

async function runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<void> {
	if (signal?.aborted) throw new Error("Operation aborted.");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
		let stdout = "";
		let stderr = "";
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
		const timer = setTimeout(() => { child.kill("SIGTERM"); cleanup(); reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`)); }, timeoutMs);
		const onAbort = () => { child.kill("SIGTERM"); cleanup(); reject(new Error("Operation aborted.")); };
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", (error) => { cleanup(); reject(error); });
		child.on("close", (code) => {
			cleanup();
			if (code === 0) return resolve();
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class WindowsHelperClient {
	private installChecked = false;
	private child?: ChildProcessWithoutNullStreams;
	private buffer = "";
	private pending = new Map<string, Pending<unknown>>();

	dispose(): void {
		const error = new Error("Windows helper closed because the Pi session ended.");
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.buffer = "";

		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		child.kill("SIGTERM");
		child.unref();
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if ((await isExecutable(WINDOWS_HELPER_PATH)) && this.installChecked) return;
		// Re-enter Electron and Bun standalone hosts as their JavaScript runtimes.
		await runProcess(process.execPath, [SETUP_HELPER_SCRIPT, "--platform", "windows", "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal, { ...process.env, ELECTRON_RUN_AS_NODE: "1", BUN_BE_BUN: "1" });
		this.installChecked = true;
		if (!(await isExecutable(WINDOWS_HELPER_PATH))) throw new Error(`Failed to install Windows helper at ${WINDOWS_HELPER_PATH}.`);
	}

	private async process(signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
		await this.ensureInstalled(signal);
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		const child = spawn(WINDOWS_HELPER_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdin.setDefaultEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.on("exit", () => { if (this.child === child) this.child = undefined; });
		child.on("error", () => { if (this.child === child) this.child = undefined; });
		this.child = child;
		this.buffer = "";
		return child;
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let parsed: any;
			try { parsed = JSON.parse(line); } catch { continue; }
			const pending = this.pending.get(parsed.id);
			if (!pending) continue;
			this.pending.delete(parsed.id);
			clearTimeout(pending.timer);
			if (parsed.protocolVersion !== WINDOWS_HELPER_PROTOCOL_VERSION) {
				pending.reject(new Error(`Windows helper protocol mismatch: expected ${WINDOWS_HELPER_PROTOCOL_VERSION}, got ${parsed.protocolVersion ?? "unknown"}. Restart Pi to use the installed helper.`));
			} else if (parsed.ok === true) {
				pending.resolve(parsed.result);
			} else {
				const error = new Error(parsed.error?.message ?? "Windows helper command failed.") as Error & { code?: string };
				error.code = parsed.error?.code;
				pending.reject(error);
			}
		}
	}

	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const child = await this.process(options?.signal);
		const id = randomUUID();
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`)); }, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			child.stdin.write(`${JSON.stringify({ protocolVersion: WINDOWS_HELPER_PROTOCOL_VERSION, id, cmd, args })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}
}

export const windowsHelper = new WindowsHelperClient();
