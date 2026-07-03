import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toBoolean, finiteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformDiagnostics } from "../types.ts";

const COMMAND_TIMEOUT_MS = 15_000;
const HELPER_PROTOCOL_VERSION = 3;
const HELPER_SETUP_TIMEOUT_MS = 60_000;

export const HELPER_BUNDLE_ID = "com.injaneity.pi-computer-use";
export const HELPER_APP_PATH = "/Applications/pi-computer-use.app";
export const HELPER_APP_EXECUTABLE_PATH = path.join(HELPER_APP_PATH, "Contents", "MacOS", "bridge");
export const HELPER_SOCKET_PATH = path.join(os.homedir(), "Library", "Caches", "pi-computer-use", "bridge.sock");

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");

export class HelperTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HelperTransportError";
	}
}

export class HelperCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "HelperCommandError";
		this.code = code;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	}).finally(() => signal?.throwIfAborted?.());
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stderr = "";
		let stdout = "";

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		child.on("close", (code) => {
			cleanup();
			if (code === 0) {
				resolve();
				return;
			}
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class MacosHelperClient {
	private helperInstallChecked = false;
	private daemonAvailable = false;
	private requestSequence = 0;
	private diagnosticsCache?: PlatformDiagnostics;

	get diagnostics(): PlatformDiagnostics | undefined {
		return this.diagnosticsCache;
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if ((await isExecutable(HELPER_APP_EXECUTABLE_PATH)) && this.helperInstallChecked) return;

		// setup-helper syncs the installed helper version/signature once per session.
		await runProcess(process.execPath, [SETUP_HELPER_SCRIPT, "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal, {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
		});
		this.helperInstallChecked = true;

		if (!(await isExecutable(HELPER_APP_EXECUTABLE_PATH))) {
			throw new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`);
		}
	}

	async launchDaemon(signal?: AbortSignal): Promise<void> {
		await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
		await runProcess("open", ["-n", "-g", "-b", HELPER_BUNDLE_ID, "--args", "serve", "--socket", HELPER_SOCKET_PATH], COMMAND_TIMEOUT_MS, signal);
	}

	async daemonCommand<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
		return await new Promise<T>((resolve, reject) => {
			const id = `req_${++this.requestSequence}`;
			const socket = net.createConnection(HELPER_SOCKET_PATH);
			let buffer = "";
			const timer = setTimeout(() => { socket.destroy(); reject(new HelperTransportError(`Daemon command '${cmd}' timed out after ${timeoutMs}ms.`)); }, timeoutMs);
			const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
			const onAbort = () => { socket.destroy(); cleanup(); reject(new Error("Operation aborted.")); };
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`));
			socket.on("data", (chunk) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				cleanup();
				socket.end();
				try {
					const parsed = JSON.parse(buffer.slice(0, newline));
					if (parsed.ok === true) resolve(parsed.result as T);
					else reject(new HelperCommandError(parsed?.error?.message ?? `Daemon command '${cmd}' failed.`, parsed?.error?.code));
				} catch (error) {
					reject(error);
				}
			});
			socket.on("error", (error) => { cleanup(); reject(new HelperTransportError(error.message)); });
		});
	}

	async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
		if (this.daemonAvailable) return true;
		try {
			await this.daemonCommand("diagnostics", {}, 1_000, signal);
			this.daemonAvailable = true;
			return true;
		} catch {}
		await this.launchDaemon(signal).catch(() => undefined);
		for (let index = 0; index < 30; index += 1) {
			try {
				await this.daemonCommand("diagnostics", {}, 1_000, signal);
				this.daemonAvailable = true;
				return true;
			} catch {
				await sleep(100, signal);
			}
		}
		return false;
	}

	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		if (!(await this.ensureDaemon(options?.signal))) {
			throw new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
		}
		try {
			return await this.daemonCommand<T>(cmd, args, timeoutMs, options?.signal);
		} catch (error) {
			this.daemonAvailable = false;
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async restart(signal?: AbortSignal): Promise<void> {
		await this.command("shutdown", {}, { signal, timeoutMs: 2_000 }).catch(() => undefined);
		this.daemonAvailable = false;
		await sleep(400, signal);
		if (!(await this.ensureDaemon(signal))) {
			throw new Error(`pi-computer-use helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`);
		}
	}

	async diagnosticsCommand(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		const result = await this.command<any>("diagnostics", {}, { signal });
		const diagnostics = {
			protocolVersion: Math.trunc(finiteNumber(result?.protocolVersion, 0)),
			pid: Math.trunc(finiteNumber(result?.pid, 0)),
			parentPid: Math.trunc(finiteNumber(result?.parentPid, 0)) || undefined,
			parentAppName: toOptionalString(result?.parentAppName),
			parentBundleId: toOptionalString(result?.parentBundleId),
			parentPath: toOptionalString(result?.parentPath),
			executablePath: toOptionalString(result?.executablePath),
			os: toOptionalString(result?.macOS),
			arch: toOptionalString(result?.arch),
			accessibility: toBoolean(result?.accessibility),
			screenRecording: toBoolean(result?.screenRecording),
		};
		this.diagnosticsCache = diagnostics;
		return diagnostics;
	}

	async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		const diagnostics = await this.diagnosticsCommand(signal);
		if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) {
			this.daemonAvailable = false;
			throw new Error(`pi-computer-use helper protocol mismatch: expected ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}. Restart Pi so the updated helper can be loaded.`);
		}
		return diagnostics;
	}
}

export const macosHelper = new MacosHelperClient();
