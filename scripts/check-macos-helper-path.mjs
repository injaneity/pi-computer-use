#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";

const homeDir = path.join(path.sep, "Users", "standard-user");
const systemHelperAppPath = path.join(path.sep, "Applications", "pi-computer-use.app");
const userHelperAppPath = path.join(homeDir, "Applications", "pi-computer-use.app");

assert.equal(
	resolveMacosHelperAppPath({ env: { PI_COMPUTER_USE_HELPER_APP_PATH: "/tmp/custom-helper.app" }, homeDir }),
	"/tmp/custom-helper.app",
	"explicit helper path should win",
);

assert.equal(
	resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath, fileExists: () => false }),
	userHelperAppPath,
	"fresh installs should use the per-user Applications directory",
);

assert.equal(
	resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath, fileExists: () => true, directoryIsWritable: () => true }),
	systemHelperAppPath,
	"existing writable system installs should remain in place",
);

assert.equal(
	resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath, fileExists: () => true, directoryIsWritable: () => false }),
	userHelperAppPath,
	"standard users should migrate away from a non-writable system install",
);

console.log("macos helper path checks passed");
