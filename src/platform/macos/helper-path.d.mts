export const HELPER_APP_NAME: string;
export const SYSTEM_HELPER_APP_PATH: string;

export interface MacosHelperPathOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	systemHelperAppPath?: string;
	fileExists?: (filePath: string) => boolean;
	directoryIsWritable?: (directoryPath: string) => boolean;
}

export function resolveMacosHelperAppPath(options?: MacosHelperPathOptions): string;
