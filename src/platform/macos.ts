import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSupport, ComputerUsePlatform } from "./index.ts";

export const HELPER_STABLE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "helpers",
  "pi-computer-use",
  "bridge",
);

const HELPER_SETUP_TIMEOUT_MS = 60_000;

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SETUP_HELPER_SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "setup-helper.mjs",
);

let _helperInstallChecked = false;

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Operation aborted.");
  }

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
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
        ),
      );
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
      reject(
        new Error(
          `Command failed (${code}): ${command} ${args.join(" ")}\n${output}`
            .trim(),
        ),
      );
    });

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isSshSession(): boolean {
  return Boolean(
    process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY,
  );
}

function helperSpawnCommand(): { command: string; args: string[] } {
  const mode = process.env.PI_COMPUTER_USE_GUI_SESSION_LAUNCH ?? "auto";
  const shouldUseGuiSession =
    mode === "1" || mode === "true" || (mode === "auto" && isSshSession());
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (shouldUseGuiSession && process.platform === "darwin" && uid !== undefined) {
    return {
      command: "launchctl",
      args: ["asuser", String(uid), HELPER_STABLE_PATH],
    };
  }
  return { command: HELPER_STABLE_PATH, args: [] };
}

async function ensureHelperInstalled(signal?: AbortSignal): Promise<void> {
  const helperAlreadyPresent = await isExecutable(HELPER_STABLE_PATH);
  if (helperAlreadyPresent && _helperInstallChecked) {
    return;
  }

  // Force ELECTRON_RUN_AS_NODE so the helper script runs as plain Node
  // instead of launching a GUI Electron app. No-op for regular Node.
  await runProcess(
    process.execPath,
    [SETUP_HELPER_SCRIPT, "--runtime"],
    HELPER_SETUP_TIMEOUT_MS,
    signal,
    { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  );
  _helperInstallChecked = true;

  if (!(await isExecutable(HELPER_STABLE_PATH))) {
    throw new Error(
      `Failed to install pi-computer-use helper at ${HELPER_STABLE_PATH}.`,
    );
  }
}

export const macosPlatform: ComputerUsePlatform = {
  name: "macos",
  helperStablePath: HELPER_STABLE_PATH,
  helperSpawnCommand() {
    return helperSpawnCommand();
  },
  async ensureHelperInstalled(signal?: AbortSignal) {
    await ensureHelperInstalled(signal);
  },
  supportsCommand(_cmd: string): CommandSupport {
    return true;
  },
};
