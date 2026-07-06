import { macosBackend } from "./macos/backend.ts";
import { isBrowserApp, isChromeFamilyApp, openBrowserLocationWithAppleScript } from "./macos/browser.ts";
import { ensureMacosReady } from "./macos/permissions.ts";
import type { ComputerUsePlatformBackend, PlatformName } from "./types.ts";
import { windowsBackend } from "./windows/backend.ts";

const macosPlatformBackend: ComputerUsePlatformBackend = {
	name: "macos",
	ensureReady: ensureMacosReady,
	listApps: macosBackend.listApps,
	listRoots: macosBackend.listRoots,
	getFrontmost: macosBackend.getFrontmost,
	focusWindow: macosBackend.focusWindow,
	observe: macosBackend.observe,
	act: macosBackend.act,
	readText: macosBackend.readText,
	waitFor: macosBackend.waitFor,
	isBrowserApp,
	isChromeFamilyApp,
	openBrowserLocation: openBrowserLocationWithAppleScript,
};

class UnsupportedPlatformBackend implements ComputerUsePlatformBackend {
	readonly name: PlatformName;

	constructor(private readonly platform: NodeJS.Platform) {
		this.name = platform === "win32" ? "windows" : "linux";
	}

	private unsupported(): never {
		throw new Error(`pi-computer-use does not support platform '${this.platform}' yet.`);
	}

	async ensureReady(): Promise<never> { this.unsupported(); }
	async listApps(): Promise<never> { this.unsupported(); }
	async listRoots(): Promise<never> { this.unsupported(); }
	async getFrontmost(): Promise<never> { this.unsupported(); }
	async focusWindow(): Promise<never> { this.unsupported(); }
	async observe(): Promise<never> { this.unsupported(); }
	async act(): Promise<never> { this.unsupported(); }
	async readText(): Promise<never> { this.unsupported(); }
	async waitFor(): Promise<never> { this.unsupported(); }
	isBrowserApp(): never { this.unsupported(); }
	isChromeFamilyApp(): never { this.unsupported(); }
	async openBrowserLocation(): Promise<boolean> { this.unsupported(); }
}

export function platformBackendForRuntime(platform: NodeJS.Platform = process.platform): ComputerUsePlatformBackend {
	if (platform === "darwin") return macosPlatformBackend;
	if (platform === "win32") return windowsBackend;
	return new UnsupportedPlatformBackend(platform);
}

export const currentPlatformBackend = platformBackendForRuntime();
