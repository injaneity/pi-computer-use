import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
}

export interface PermissionBridge {
	checkPermissions(signal?: AbortSignal): Promise<PermissionStatus>;
	openPermissionPane(kind: "accessibility" | "screenRecording", signal?: AbortSignal): Promise<void>;
	copyHelperPathToClipboard?(signal?: AbortSignal): Promise<void>;
	permissionHint?: string;
}

const NON_INTERACTIVE_PERMISSION_ERROR =
	"pi-computer-use setup requires an interactive session. Start pi in interactive mode and grant Accessibility and Screen Recording to pi-computer-use.app. Screen Recording lets the agent see the window. Accessibility lets it interact with the window.";

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted.");
	}
}

function missingKinds(status: PermissionStatus): string[] {
	const missing: string[] = [];
	if (!status.accessibility) missing.push("Accessibility");
	if (!status.screenRecording) missing.push("Screen Recording");
	return missing;
}

function permissionStatusSummary(status: PermissionStatus): string {
	return [
		`Accessibility: ${status.accessibility ? "granted" : "missing"}`,
		`Screen Recording: ${status.screenRecording ? "granted" : "missing"}`,
	].join("; ");
}

function helperNameFromPath(helperPath: string): string {
	return helperPath.split(/[\\/]/).filter(Boolean).pop() ?? "helper";
}

export async function ensurePermissions(
	ctx: ExtensionContext,
	bridge: PermissionBridge,
	helperPath: string,
	signal?: AbortSignal,
): Promise<PermissionStatus> {
	const helperName = helperNameFromPath(helperPath);
	let status = await bridge.checkPermissions(signal);
	if (status.accessibility && status.screenRecording) {
		return status;
	}

	if (!ctx.hasUI) {
		throw new Error(`${NON_INTERACTIVE_PERMISSION_ERROR}\nHelper path: ${helperPath}`);
	}

	while (!status.accessibility || !status.screenRecording) {
		throwIfAborted(signal);

		const options: string[] = [];
		if (!status.accessibility) options.push("Open Accessibility Settings (missing)");
		if (!status.screenRecording) options.push("Open Screen Recording Settings (missing)");
		options.push("Recheck permissions", "Cancel");

		const prompt = [
			"pi-computer-use needs macOS permissions for its helper app.",
			permissionStatusSummary(status),
			"",
			`Helper: ${helperName}`,
			`Path: ${helperPath}`,
			bridge.permissionHint,
			"",
			"Open the missing setting, enable pi-computer-use.app, then choose Recheck.",
			"If it is not listed, click +, choose Applications, select pi-computer-use.app, add it, then enable it.",
			"If you are upgrading from pi-computer-use 0.3.2 or earlier, old entries such as bridge, Terminal, Ghostty, node, or Codex are not the canonical helper anymore. Grant pi-computer-use.app.",
		].filter(Boolean).join("\n");

		const choice = await ctx.ui.select(prompt, options, { signal });
		if (!choice || choice === "Cancel") {
			throw new Error(
				`pi-computer-use setup is incomplete. Grant Accessibility and Screen Recording to pi-computer-use.app at ${helperPath}, then retry. Screen Recording lets the agent see the window. Accessibility lets it interact with the window.`,
			);
		}

		if (choice.startsWith("Open Accessibility Settings")) {
			await bridge.openPermissionPane("accessibility", signal);
			await bridge.copyHelperPathToClipboard?.(signal).catch(() => undefined);
			ctx.ui.notify(`Opened Accessibility and copied helper path: ${helperPath}`, "info");
		} else if (choice.startsWith("Open Screen Recording Settings")) {
			await bridge.openPermissionPane("screenRecording", signal);
			await bridge.copyHelperPathToClipboard?.(signal).catch(() => undefined);
			ctx.ui.notify(`Opened Screen Recording and copied helper path: ${helperPath}`, "info");
		}

		status = await bridge.checkPermissions(signal);
		if (status.accessibility && status.screenRecording) {
			ctx.ui.notify("pi-computer-use is ready.", "info");
		} else {
			const stillMissing = missingKinds(status).join(" and ");
			ctx.ui.notify(`Still missing: ${stillMissing}. ${permissionStatusSummary(status)}. Restart Pi/the Mac if macOS asked you to.`, "warning");
		}
	}

	return status;
}
