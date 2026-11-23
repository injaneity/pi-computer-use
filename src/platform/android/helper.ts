import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface AndroidHelperClientOptions { credentialPath?: string }
interface Credentials { port: number; secret: string }
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

function authenticationProof(secret: string, role: string, nonce: string): string {
	return createHmac("sha256", secret).update(`pi-cu-android-v1:${role}:${nonce}`).digest("hex");
}

async function credentials(file: string): Promise<Credentials> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error("Android credential permissions must be 0600 and contents bounded.");
		const value: unknown = JSON.parse(await handle.readFile("utf8"));
		if (!value || typeof value !== "object") throw new Error("Invalid Android credentials.");
		const { port, secret } = value as Partial<Credentials>;
		if (!Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error("Invalid Android loopback port.");
		if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) throw new Error("Invalid Android pairing secret.");
		return { port: port!, secret };
	} finally { await handle.close(); }
}

/** One authenticated connection per command. No reconnect/replay after dispatch. */
export class AndroidHelperClient {
	private readonly credentialPath: string;
	private readonly sockets = new Set<net.Socket>();
	private closed = false;

	constructor(options: AndroidHelperClientOptions = {}) {
		this.credentialPath = options.credentialPath ?? process.env.PI_COMPUTER_USE_ANDROID_CREDENTIALS
			?? path.join(os.homedir(), ".config", "pi-computer-use", "android.json");
	}

	dispose(): void {
		this.closed = true;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
	}

	async command<T = unknown>(cmd: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		if (this.closed) throw new Error("Android helper client is closed.");
		if (options.signal?.aborted) throw new Error("Operation aborted.");
		const config = await credentials(this.credentialPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") throw new Error("Pair Android first: run node scripts/pair-android.mjs --clipboard, then confirm in Pi Computer Use.");
			throw error;
		});
		if (this.closed) throw new Error("Android helper client is closed.");
		if (options.signal?.aborted) throw new Error("Operation aborted.");
		const timeoutMs = Math.max(100, Math.min(30000, options.timeoutMs ?? 10000));
		const request = JSON.stringify({ protocolVersion: 1, id: 1, cmd, args, timeoutMs });
		if (Buffer.byteLength(request) > 256 * 1024) throw new Error("Android request exceeds the protocol bound.");
		return await new Promise<T>((resolve, reject) => {
			const socket = net.createConnection({ host: "127.0.0.1", port: config.port });
			this.sockets.add(socket);
			socket.setEncoding("utf8");
			let buffer = "";
			let phase: "server" | "client" | "response" = "server";
			let finished = false;
			const nonce = randomBytes(32).toString("hex");
			const finish = (error?: Error, value?: T): void => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				this.sockets.delete(socket);
				socket.destroy();
				if (error) reject(error); else resolve(value as T);
			};
			const abort = (): void => finish(new Error("Operation aborted. If input was dispatched, observe before continuing."));
			const timer = setTimeout(() => finish(new Error("Android request timed out. Its outcome may be unknown; do not replay input.")), timeoutMs + 2000);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) { abort(); return; }
			socket.on("connect", () => socket.write(`${JSON.stringify({ protocolVersion: 1, nonce })}\n`));
			socket.on("error", (error) => finish(error));
			socket.on("close", () => finish(new Error("Android connection closed. Any dispatched input has an unknown outcome; observe again.")));
			socket.on("data", (chunk: string) => {
				if (finished) return;
				buffer += chunk;
				if (Buffer.byteLength(buffer) > (phase === "response" ? MAX_RESPONSE_BYTES : 4096)) { finish(new Error("Android protocol response exceeds its bound.")); return; }
				try {
					let newline: number;
					while (!finished && (newline = buffer.indexOf("\n")) >= 0) {
						const value = JSON.parse(buffer.slice(0, newline));
						buffer = buffer.slice(newline + 1);
						if (!value || typeof value !== "object") throw new Error("Invalid Android protocol envelope.");
						if (phase === "server") {
							if (value.protocolVersion !== 1 || !/^[0-9a-f]{64}$/.test(value.nonce ?? "") || !/^[0-9a-f]{64}$/.test(value.proof ?? "")) throw new Error("Android authentication failed.");
							const expected = authenticationProof(config.secret, "server", nonce);
							if (!timingSafeEqual(Buffer.from(expected), Buffer.from(value.proof))) throw new Error("Android server authentication failed.");
							phase = "client";
							socket.write(`${JSON.stringify({ proof: authenticationProof(config.secret, "client", value.nonce) })}\n`);
						} else if (phase === "client") {
							if (value.authenticated !== true) throw new Error("Android client authentication failed.");
							phase = "response";
							socket.write(request + "\n");
						} else {
							if (value.protocolVersion !== 1 || value.id !== 1 || typeof value.ok !== "boolean") throw new Error("Android protocol response id or version mismatch.");
							if (!value.ok) {
								const error = new Error(typeof value.error?.message === "string" ? value.error.message : "Android request failed.") as Error & { code?: string };
								error.code = typeof value.error?.code === "string" ? value.error.code : "native_error";
								finish(error);
							} else finish(undefined, value.result as T);
						}
					}
				} catch (error) { finish(error instanceof Error ? error : new Error("Invalid Android protocol response.")); }
			});
		});
	}
}
