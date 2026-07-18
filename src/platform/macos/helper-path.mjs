import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HELPER_APP_NAME = "pi-computer-use.app";
export const SYSTEM_HELPER_APP_PATH = path.join("/Applications", HELPER_APP_NAME);

/**
 * Resolve one stable helper location for both installation and runtime use.
 * Existing writable system installs stay in place; all other installs are
 * per-user so standard macOS accounts never require administrator access.
 */
export function resolveMacosHelperAppPath(options = {}) {
	const env = options.env ?? process.env;
	const explicitPath = env.PI_COMPUTER_USE_HELPER_APP_PATH?.trim();
	if (explicitPath) return path.resolve(explicitPath);

	const homeDir = options.homeDir ?? os.homedir();
	const systemHelperAppPath = options.systemHelperAppPath ?? SYSTEM_HELPER_APP_PATH;
	const fileExists = options.fileExists ?? existsSync;
	const directoryIsWritable = options.directoryIsWritable ?? ((directoryPath) => {
		try {
			accessSync(directoryPath, fsConstants.W_OK);
			return true;
		} catch {
			return false;
		}
	});

	if (fileExists(systemHelperAppPath) && directoryIsWritable(path.dirname(systemHelperAppPath))) {
		return systemHelperAppPath;
	}
	return path.join(homeDir, "Applications", HELPER_APP_NAME);
}
