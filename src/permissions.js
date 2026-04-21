export async function ensurePermissions(ctx, bridge, helperPath, signal) {
	const NON_INTERACTIVE_PERMISSION_ERROR =
		"Computer use requires interactive permission setup. Start pi in interactive mode and grant Accessibility and Screen Recording to the signed pi-computer-use helper. Accessibility is mandatory for AX-first computer use.";

	function throwIfAborted(signal) {
		if (signal?.aborted) {
			throw new Error("Operation aborted.");
		}
	}

	function missingKinds(status) {
		const missing = [];
		if (!status.accessibility) missing.push("Accessibility");
		if (!status.screenRecording) missing.push("Screen Recording");
		return missing;
	}

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
		const options = [];
		if (!status.accessibility) options.push("Open Accessibility Settings");
		if (!status.screenRecording) options.push("Open Screen Recording Settings");
		options.push("Recheck", "Cancel");

		const prompt = [
			`Computer use needs ${missing.join(" and ")} permission.`,
			"Accessibility is required for AX-first background control. Screen Recording is required for screenshots.",
			"Grant permissions to the signed pi-computer-use helper:",
			helperPath,
			"After enabling permissions in System Settings, return here and choose Recheck.",
		].join("\n");

		const choice = await ctx.ui.select(prompt, options, { signal });
		if (!choice || choice === "Cancel") {
			throw new Error(
				`Computer use permission setup was cancelled. Grant Accessibility and Screen Recording to the signed pi-computer-use helper at ${helperPath}, then retry. Accessibility is required for AX-first computer use.`,
			);
		}

		if (choice === "Open Accessibility Settings") {
			await bridge.openPermissionPane("accessibility", signal);
			ctx.ui.notify("Opened Accessibility settings. Enable the helper, then choose Recheck.", "info");
		} else if (choice === "Open Screen Recording Settings") {
			await bridge.openPermissionPane("screenRecording", signal);
			ctx.ui.notify("Opened Screen Recording settings. Enable the helper, then choose Recheck.", "info");
		}

		status = await bridge.checkPermissions(signal);
	}

	return status;
}
