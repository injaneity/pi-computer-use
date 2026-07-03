import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensurePermissions, type PermissionStatus } from "../../permissions.ts";
import { toBoolean, finiteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformReadyState } from "../types.ts";
import { HELPER_APP_PATH, macosHelper } from "./helper.ts";

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await macosHelper.command<any>("checkPermissions", {}, { signal });
	const rawSource = result?.source;
	return {
		accessibility: toBoolean(result?.accessibility),
		// Authoritative: the helper's live ScreenCaptureKit probe (falls back
		// to the plain boolean when talking to a protocol-1 helper).
		screenRecording: toBoolean(result?.screenRecordingCapturable ?? result?.screenRecording),
		screenRecordingPreflight: toBoolean(result?.screenRecordingPreflight ?? result?.screenRecording),
		source: rawSource && typeof rawSource === "object"
			? {
				attribution: rawSource.attribution === "helper-app" ? "helper-app" : "caller",
				pid: Math.trunc(finiteNumber(rawSource.pid, 0)) || undefined,
				parentPid: Math.trunc(finiteNumber(rawSource.parentPid, 0)) || undefined,
				executablePath: toOptionalString(rawSource.executablePath),
				parentPath: toOptionalString(rawSource.parentPath),
				parentBundleId: toOptionalString(rawSource.parentBundleId),
				macOS: toOptionalString(rawSource.macOS),
			}
			: undefined,
	};
}

async function registerPermissions(signal?: AbortSignal): Promise<void> {
	await macosHelper.command("registerPermissions", {}, { signal, timeoutMs: 15_000 });
}

export async function ensureMacosReady(
	ctx: ExtensionContext,
	state: PlatformReadyState,
	signal?: AbortSignal,
): Promise<PlatformReadyState> {
	await macosHelper.ensureInstalled(signal);
	if (!(await macosHelper.ensureDaemon(signal))) {
		throw new Error(`pi-computer-use helper app daemon did not start. Helper app: ${HELPER_APP_PATH}`);
	}
	const helperDiagnostics = await macosHelper.ensureProtocol(signal);

	const now = Date.now();
	const cachedStatus = state.permissionStatus;
	const canUseCachedPermissions =
		cachedStatus?.accessibility &&
		cachedStatus.screenRecording &&
		now - state.lastPermissionCheckAt < 2_000;
	if (canUseCachedPermissions) {
		return { ...state, helperDiagnostics };
	}

	let permissionStatus = await checkPermissions(signal);
	let lastPermissionCheckAt = now;

	if (!permissionStatus.accessibility || !permissionStatus.screenRecording) {
		// Attribution "caller" means the helper is not running as the
		// canonical installed app — grants would attach to the wrong identity.
		const attributionHint = permissionStatus.source?.attribution === "caller"
			? `Warning: the helper is not running as the installed pi-computer-use.app (executable: ${permissionStatus.source?.executablePath ?? "unknown"}). Grants made now would attach to the launching app instead. Restart Pi so the canonical helper is used.`
			: undefined;
		permissionStatus = await ensurePermissions(
			ctx,
			{
				checkPermissions: (permissionSignal) => checkPermissions(permissionSignal ?? signal),
				registerPermissions: (permissionSignal) => registerPermissions(permissionSignal ?? signal),
				openPermissionPane: async (kind, permissionSignal) => {
					await macosHelper.command("openPermissionPane", { kind }, { signal: permissionSignal ?? signal });
				},
				restartHelper: (permissionSignal) => macosHelper.restart(permissionSignal ?? signal),
				permissionHint: attributionHint,
			},
			HELPER_APP_PATH,
			signal,
		);
		lastPermissionCheckAt = Date.now();
	}

	return { permissionStatus, lastPermissionCheckAt, helperDiagnostics };
}
