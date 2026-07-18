export interface MacosHelperPathOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	systemHelperAppPath?: string;
	fileExists?: (filePath: string) => boolean;
	directoryIsWritable?: (directoryPath: string) => boolean;
}

export function resolveMacosHelperAppPath(options?: MacosHelperPathOptions): string;
