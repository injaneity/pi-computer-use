import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
}

export interface PermissionBridge {
	checkPermissions(signal?: AbortSignal): Promise<PermissionStatus>;
	openPermissionPane(kind: "accessibility" | "screenRecording", signal?: AbortSignal): Promise<void>;
	copyHelperPathToClipboard?(signal?: AbortSignal): Promise<void>;
}

const NON_INTERACTIVE_PERMISSION_ERROR =
	"pi-computer-use setup requires an interactive session. Start pi in interactive mode and grant Accessibility and Screen Recording to the pi-computer-use helper. Screen Recording lets the agent see the window. Accessibility lets it interact with the window.";

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

		const missing = missingKinds(status);
		const options: string[] = [];
		if (!status.accessibility) options.push("Open Accessibility Settings");
		if (!status.screenRecording) options.push("Open Screen Recording Settings");
		options.push("Recheck", "Cancel");

		const prompt = [
			"pi-computer-use needs a one-time macOS setup before its tools can run.",
			`Missing permissions: ${missing.join(" and ")}`,
			"",
			"What each permission does:",
			"- Screen Recording: lets the agent see the target window and provide screenshot/vision context",
			"- Accessibility: lets the agent click, focus, and type in the target window",
			"",
			"Grant permissions to this helper:",
			helperPath,
			"",
			`Open the missing System Settings panes, enable ${helperName}, then return here and choose Recheck.`,
			`The helper path is copied to your clipboard. If ${helperName} is not listed automatically, click + in Settings, press Cmd+Shift+G, paste the helper path, add ${helperName}, enable it, then choose Recheck.`,
			"If macOS says a restart is required, restart Pi and/or the Mac before choosing Recheck.",
		].join("\n");

		const choice = await ctx.ui.select(prompt, options, { signal });
		if (!choice || choice === "Cancel") {
			throw new Error(
				`pi-computer-use setup is incomplete. Grant Accessibility and Screen Recording to ${helperPath}, then retry. Screen Recording lets the agent see the window. Accessibility lets it interact with the window.`,
			);
		}

		if (choice === "Open Accessibility Settings") {
			await bridge.openPermissionPane("accessibility", signal);
			await bridge.copyHelperPathToClipboard?.(signal).catch(() => undefined);
			ctx.ui.notify(`Requested Accessibility permission, opened settings, and copied the ${helperName} path to your clipboard. Enable ${helperName} if shown. If not, click +, press Cmd+Shift+G, paste the path, add ${helperName}, then choose Recheck. Restart Pi/the Mac if macOS asks.`, "info");
		} else if (choice === "Open Screen Recording Settings") {
			await bridge.openPermissionPane("screenRecording", signal);
			await bridge.copyHelperPathToClipboard?.(signal).catch(() => undefined);
			ctx.ui.notify(`Requested Screen Recording permission, opened settings, and copied the ${helperName} path to your clipboard. Enable ${helperName} if shown. If not, click +, press Cmd+Shift+G, paste the path, add ${helperName}, then choose Recheck. Restart Pi/the Mac if macOS asks.`, "info");
		}

		status = await bridge.checkPermissions(signal);
		if (status.accessibility && status.screenRecording) {
			ctx.ui.notify(`pi-computer-use permissions are ready. ${permissionStatusSummary(status)}`, "info");
		} else {
			ctx.ui.notify(`pi-computer-use permissions are still incomplete. ${permissionStatusSummary(status)}. If you just enabled a permission and macOS requested a restart, restart Pi and/or the Mac, then retry.`, "warning");
		}
	}

	return status;
}
