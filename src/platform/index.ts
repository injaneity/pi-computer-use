export type PlatformName = "macos" | "windows";
export type CommandSupport = true | "capability_deferred" | "unsupported_command";

export interface HelperSpawnCommand {
  command: string;
  args: string[];
}

export interface ComputerUsePlatform {
  name: PlatformName;
  helperStablePath: string;
  helperSpawnCommand(): HelperSpawnCommand;
  ensureHelperInstalled(signal?: AbortSignal): Promise<void>;
  supportsCommand(cmd: string): CommandSupport;
}

import { macosPlatform } from "./macos.ts";
import { windowsPlatform } from "./windows.ts";

export function platformForRuntime(platform: NodeJS.Platform = process.platform): ComputerUsePlatform {
  if (platform === "darwin") return macosPlatform;
  if (platform === "win32") return windowsPlatform;
  throw new Error(`pi-computer-use does not support platform '${platform}'.`);
}
