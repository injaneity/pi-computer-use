#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureIdentityOnce, parseCodeSigningIdentities, shouldResetTccForSigningChange, withDirectoryLock } from "./setup-helper.mjs";

const sample = `
Policy: Code Signing
  Matching identities
  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "pi-computer-use Local Signing" (CSSMERR_TP_NOT_TRUSTED)
  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "pi-computer-use Local Signing (old)" (CSSMERR_TP_NOT_TRUSTED)
  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "pi-computer-use Local Signing" (CSSMERR_TP_NOT_TRUSTED)
     3 identities found
`;

assert.deepEqual(parseCodeSigningIdentities(sample), [
	"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
]);

assert.equal(shouldResetTccForSigningChange("adhoc", "cert:aaaa"), true);
assert.equal(shouldResetTccForSigningChange("cert:bbbb", "cert:aaaa"), true);
assert.equal(shouldResetTccForSigningChange("cert:aaaa", "cert:aaaa"), false);
assert.equal(shouldResetTccForSigningChange(undefined, "cert:aaaa"), false);
assert.equal(shouldResetTccForSigningChange("unknown", "cert:aaaa"), false);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-test-"));
const lockPath = path.join(tempDir, "identity.lock");
let identity;
let createCount = 0;

try {
	const results = await Promise.all(Array.from({ length: 12 }, () => ensureIdentityOnce(
		async () => identity,
		async () => {
			createCount++;
			await new Promise((resolve) => setTimeout(resolve, 20));
			identity = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
			return identity;
		},
		(callback) => withDirectoryLock(lockPath, callback, { waitMs: 2_000, retryMs: 5 }),
	)));

	assert.equal(createCount, 1, "concurrent callers must create only one identity");
	assert.deepEqual(new Set(results), new Set([identity]));
} finally {
	await fs.rm(tempDir, { force: true, recursive: true });
}

console.log("[check-local-signing] identity parsing and concurrent creation passed");
