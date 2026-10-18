// Pure jev enablement gate, kept out of the coordinator so it is unit-testable
// without a live session.

export interface JevGateConfig {
	jev_enabled: boolean;
	browser_use: boolean;
}

/** The reason jev tools are refused, or undefined when the layer is enabled. */
export function jevGateError(config: JevGateConfig): string | undefined {
	if (!config.jev_enabled) {
		return "The jev tool surface is disabled (jev_enabled). Set PI_COMPUTER_USE_JEV_ENABLED=1, enable jev_enabled in configuration, or run /computer-use jev on.";
	}
	if (!config.browser_use) {
		return "The jev browser layer needs browser_use enabled. Set PI_COMPUTER_USE_BROWSER_USE=1 or enable browser_use in configuration.";
	}
	return undefined;
}
