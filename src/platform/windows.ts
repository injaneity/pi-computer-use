import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSupport, ComputerUsePlatform } from "./index.ts";

// Commands  that the Windows helper supports and returns data for.
const SUPPORTED = new Set([
  "listWindows",
  "screenshot",
  "listApps",
]);

// Commands that are planned but deferred to a future PR.
// The Rust helper returns capability_deferred for these.
const DEFERRED = new Set([
  "checkPermissions",
  "getFrontmost",
  "axListTargets",
  "mouseClick",
  "mouseMove",
  "mouseDrag",
  "scrollWheel",
  "keyPress",
  "typeText",
  "setValue",
  "axPressElement",
  "axScrollElement",
  "navigateBrowser",
  "evaluateBrowser",
  "launchBrowserContext",
  "computerActions",
  "axWaitFor",
]);

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

const HELPER_SETUP_TIMEOUT_MS = 60_000;

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

export const WINDOWS_HELPER_STABLE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "helpers",
  "pi-computer-use",
  "windows-bridge.exe",
);

export const windowsPlatform: ComputerUsePlatform = {
  name: "windows",
  helperStablePath: WINDOWS_HELPER_STABLE_PATH,
  helperSpawnCommand() {
    return { command: WINDOWS_HELPER_STABLE_PATH, args: [] };
  },
  async ensureHelperInstalled(signal?: AbortSignal) {
    const helperAlreadyPresent = await isExecutable(WINDOWS_HELPER_STABLE_PATH);
    if (helperAlreadyPresent && _helperInstallChecked) {
      return;
    }

    await runProcess(
      process.execPath,
      [SETUP_HELPER_SCRIPT, "--platform", "windows", "--runtime"],
      HELPER_SETUP_TIMEOUT_MS,
      signal,
      { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    );
    _helperInstallChecked = true;

    if (!(await isExecutable(WINDOWS_HELPER_STABLE_PATH))) {
      throw new Error(
        `Failed to install Windows helper at ${WINDOWS_HELPER_STABLE_PATH}.`,
      );
    }
  },
  supportsCommand(cmd: string): CommandSupport {
    if (SUPPORTED.has(cmd)) return true;
    if (DEFERRED.has(cmd)) return "capability_deferred";
    return "unsupported_command";
  },
};
