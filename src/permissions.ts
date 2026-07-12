import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Which process identity the permission answers reflect. Platforms may
// attribute grants to a responsible parent process rather than the helper
// executable itself.
export type PermissionAttribution = "helper-app" | "caller";
export type PermissionKind = "accessibility" | "screenRecording";

export interface PermissionSource {
	attribution: PermissionAttribution;
	pid?: number;
	parentPid?: number;
	executablePath?: string;
	parentPath?: string;
	parentBundleId?: string;
	os?: string;
}

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
	screenRecordingPreflight?: boolean;
	source?: PermissionSource;
}

interface PermissionKindCopy {
	kind: PermissionKind;
	openOption: string;
}

interface PermissionFlowCopy {
	nonInteractiveError(helperPath: string): string;
	prompt(status: PermissionStatus, helperPath: string, hint?: string): string;
	incompleteError(helperPath: string): string;
	readyMessage: string;
	stillMissing(kinds: PermissionKind[]): string;
}

export interface PermissionBridge {
	kinds: PermissionKindCopy[];
	copy: PermissionFlowCopy;
	checkPermissions(signal?: AbortSignal): Promise<PermissionStatus>;
	registerPermissions(signal?: AbortSignal): Promise<void>;
	openPermissionPane(kind: PermissionKind, signal?: AbortSignal): Promise<void>;
	// Platforms may cache permission answers per process, so restart before
	// recheck lets a new grant become visible to the helper.
	restartHelper(signal?: AbortSignal): Promise<void>;
	permissionHint?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

function granted(status: PermissionStatus, kind: PermissionKind): boolean {
	return status[kind] === true;
}

function allGranted(status: PermissionStatus, kinds: PermissionKindCopy[]): boolean {
	return kinds.every(({ kind }) => granted(status, kind));
}

function missingKinds(status: PermissionStatus, kinds: PermissionKindCopy[]): PermissionKind[] {
	return kinds.flatMap(({ kind }) => granted(status, kind) ? [] : [kind]);
}

export async function ensurePermissions(
	ctx: ExtensionContext,
	bridge: PermissionBridge,
	helperPath: string,
	signal?: AbortSignal,
): Promise<PermissionStatus> {
	let status = await bridge.checkPermissions(signal);
	if (allGranted(status, bridge.kinds)) return status;

	if (!ctx.hasUI) throw new Error(bridge.copy.nonInteractiveError(helperPath));

	// Register before prompting so platform settings panes can already list
	// the helper and the user only has to enable existing entries.
	await bridge.registerPermissions(signal).catch(() => undefined);

	while (!allGranted(status, bridge.kinds)) {
		throwIfAborted(signal);

		const missing = missingKinds(status, bridge.kinds);
		const options = bridge.kinds
			.filter(({ kind }) => missing.includes(kind))
			.map(({ openOption }) => openOption);
		options.push("Recheck (restarts helper)", "Cancel");

		const choice = await ctx.ui.select(bridge.copy.prompt(status, helperPath, bridge.permissionHint), options, { signal });
		if (!choice || choice === "Cancel") throw new Error(bridge.copy.incompleteError(helperPath));

		const selected = bridge.kinds.find(({ openOption }) => choice === openOption);
		if (selected) await bridge.openPermissionPane(selected.kind, signal);

		if (choice.startsWith("Recheck")) {
			// Restart first: permission decisions can be cached by a running
			// helper process and remain stale after the user grants access.
			await bridge.restartHelper(signal);
			status = await bridge.checkPermissions(signal);
			if (allGranted(status, bridge.kinds)) {
				ctx.ui.notify(bridge.copy.readyMessage, "info");
			} else {
				ctx.ui.notify(bridge.copy.stillMissing(missingKinds(status, bridge.kinds)), "warning");
			}
		}
	}

	return status;
}
