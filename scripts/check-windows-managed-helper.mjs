#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installConfiguredWindowsPrebuilt } from "../src/platform/windows/helper.ts";

const testRoot = await mkdtemp(path.join(os.tmpdir(), "pi-cu-managed-windows-helper-"));
try {
	const prebuiltPath = path.join(testRoot, "package", "windows-bridge.exe");
	const overridePath = path.join(testRoot, "managed", "windows-bridge.exe");
	await mkdir(path.dirname(prebuiltPath), { recursive: true });
	await writeFile(prebuiltPath, "new-managed-helper", { mode: 0o755 });
	await chmod(prebuiltPath, 0o755);

	assert.equal(
		await installConfiguredWindowsPrebuilt({ overridePath: "", prebuiltPath }),
		false,
		"an explicit managed helper path is required",
	);

	assert.equal(await installConfiguredWindowsPrebuilt({ overridePath, prebuiltPath }), true);
	assert.equal(await readFile(overridePath, "utf8"), "new-managed-helper");

	await writeFile(overridePath, "stale-helper");
	assert.equal(await installConfiguredWindowsPrebuilt({ overridePath, prebuiltPath }), true);
	assert.equal(await readFile(overridePath, "utf8"), "new-managed-helper");
	assert.deepEqual(
		(await readdir(path.dirname(overridePath))).filter((name) => name.includes(".tmp-")),
		[],
		"atomic install leaves no temporary helper behind",
	);

	assert.equal(
		await installConfiguredWindowsPrebuilt({ overridePath, prebuiltPath: path.join(testRoot, "missing.exe") }),
		false,
		"a missing packaged prebuilt falls back to the regular installer",
	);
	console.log("managed Windows helper checks passed");
} finally {
	await rm(testRoot, { recursive: true, force: true });
}
