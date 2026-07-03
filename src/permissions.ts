import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Which TCC identity the permission booleans reflect. macOS attributes
 * Accessibility / Screen Recording to the *responsible process* (the app at
 * the top of the launch chain), not to an executable path.
 *
 * - `helper-app`: the canonical installed pi-computer-use.app, launched via
 *   LaunchServices. The normal case.
 * - `caller`: anything else (dev binary spawned from a terminal, etc.) —
 *   grants belong to whatever launched it, not the canonical helper.
 */
export type PermissionAttribution = "helper-app" | "caller";

export interface PermissionSource {
	attribution: PermissionAttribution;
	pid?: number;
	parentPid?: number;
	executablePath?: string;
	parentPath?: string;
	parentBundleId?: string;
	macOS?: string;
}

export interface PermissionStatus {
	accessibility: boolean;
	/**
	 * Authoritative Screen Recording state: a live ScreenCaptureKit probe
	 * from inside the helper process. The CGPreflight boolean is exposed
	 * separately because the two disagreeing is itself a diagnostic (stale
	 * per-process cache, or a grant row belonging to a different identity).
	 */
	screenRecording: boolean;
	screenRecordingPreflight?: boolean;
	source?: PermissionSource;
}

export interface PermissionBridge {
	checkPermissions(signal?: AbortSignal): Promise<PermissionStatus>;
	/**
	 * Raise the AX prompt and perform a real ScreenCaptureKit attempt so the
	 * helper appears in BOTH Settings panes before the user is sent there
	 * (recent macOS only lists an app under Screen Recording after an actual
	 * capture attempt).
	 */
	registerPermissions(signal?: AbortSignal): Promise<void>;
	openPermissionPane(kind: "accessibility" | "screenRecording", signal?: AbortSignal): Promise<void>;
	/**
	 * Stop and relaunch the helper process. Required before every recheck:
	 * TCC answers are cached per process, so a helper that saw "denied"
	 * keeps answering "denied" after the user grants — only a fresh process
	 * re-queries tccd.
	 */
	restartHelper(signal?: AbortSignal): Promise<void>;
	permissionHint?: string;
}

const GRANT_INSTRUCTIONS =
	"Grant Accessibility and Screen Recording to pi-computer-use.app in System Settings → Privacy & Security. " +
	"Screen Recording lets the agent see the window; Accessibility lets it interact with the window.";

const NON_INTERACTIVE_PERMISSION_ERROR =
	`pi-computer-use setup requires an interactive session. Start pi in interactive mode. ${GRANT_INSTRUCTIONS}`;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted.");
	}
}

function allGranted(status: PermissionStatus): boolean {
	return status.accessibility && status.screenRecording;
}

function missingKinds(status: PermissionStatus): Array<"accessibility" | "screenRecording"> {
	const missing: Array<"accessibility" | "screenRecording"> = [];
	if (!status.accessibility) missing.push("accessibility");
	if (!status.screenRecording) missing.push("screenRecording");
	return missing;
}

function permissionStatusSummary(status: PermissionStatus): string {
	const lines = [
		`Accessibility: ${status.accessibility ? "granted" : "missing"}`,
		`Screen Recording: ${status.screenRecording ? "granted" : "missing"}`,
	];
	if (status.screenRecordingPreflight && !status.screenRecording) {
		lines.push(
			"(Screen Recording reads granted in the TCC database but a live capture probe failed — " +
			"the grant likely belongs to a different app identity, or the helper needs a restart.)",
		);
	}
	return lines.join("; ");
}

/**
 * Ensure both grants are active for the helper's identity.
 *
 *   1. Check via the live probes; done if green.
 *   2. Register both TCC rows (AX prompt + real ScreenCaptureKit attempt) so
 *      the app is already listed in both Settings panes.
 *   3. Guide the user through ONE Settings visit.
 *   4. On recheck, restart the helper first — a fresh process is the only
 *      reliable way past the per-process TCC cache.
 */
export async function ensurePermissions(
	ctx: ExtensionContext,
	bridge: PermissionBridge,
	helperPath: string,
	signal?: AbortSignal,
): Promise<PermissionStatus> {
	let status = await bridge.checkPermissions(signal);
	if (allGranted(status)) {
		return status;
	}

	if (!ctx.hasUI) {
		throw new Error(`${NON_INTERACTIVE_PERMISSION_ERROR}\nHelper path: ${helperPath}`);
	}

	// Register both rows up front: after this, pi-computer-use.app is listed
	// in both panes and the user only has to flip toggles — no "+" button,
	// no path-picking.
	await bridge.registerPermissions(signal).catch(() => undefined);

	while (!allGranted(status)) {
		throwIfAborted(signal);

		const missing = missingKinds(status);
		const options: string[] = [];
		if (missing.includes("accessibility")) options.push("Open Accessibility Settings (missing)");
		if (missing.includes("screenRecording")) options.push("Open Screen Recording Settings (missing)");
		options.push("Recheck (restarts helper)", "Cancel");

		const prompt = [
			"pi-computer-use needs macOS permissions for its helper app.",
			permissionStatusSummary(status),
			"",
			`Helper: pi-computer-use.app (${helperPath})`,
			bridge.permissionHint,
			"",
			"pi-computer-use.app is already listed in the pane(s) — enable its toggle, then choose Recheck.",
		].filter(Boolean).join("\n");

		const choice = await ctx.ui.select(prompt, options, { signal });
		if (!choice || choice === "Cancel") {
			throw new Error(
				`pi-computer-use setup is incomplete. ${GRANT_INSTRUCTIONS} Helper path: ${helperPath}`,
			);
		}

		if (choice.startsWith("Open Accessibility Settings")) {
			await bridge.openPermissionPane("accessibility", signal);
		} else if (choice.startsWith("Open Screen Recording Settings")) {
			await bridge.openPermissionPane("screenRecording", signal);
		}

		if (choice.startsWith("Recheck")) {
			// Restart before rechecking: the running helper's TCC answers are
			// cached per process and will not reflect a grant made after it
			// started.
			await bridge.restartHelper(signal);
			status = await bridge.checkPermissions(signal);
			if (allGranted(status)) {
				ctx.ui.notify("pi-computer-use is ready.", "info");
			} else {
				ctx.ui.notify(`Still missing after restart: ${missingKinds(status).join(" and ")}.`, "warning");
			}
		}
	}

	return status;
}
