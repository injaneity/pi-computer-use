#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'pi-android-setup-'));
try {
    for (const args of [['--platform','android'], ['--platform','android','--postinstall'], ...(process.platform === 'android' ? [[]] : [])]) {
        const out = execFileSync(process.execPath, ['scripts/setup-helper.mjs', ...args], {
            encoding:'utf8', env:{...process.env,HOME:home}, timeout:10000,
        });
        assert.match(out, /Android companion/);
        assert.match(out, /pair-android\.mjs --clipboard/);
        assert.match(out, /manually/i);
        assert.deepEqual(await readdir(home), [], 'Setup must not create credentials, install an APK, or enable a service');
    }
    const manifest = JSON.parse(await readFile('package.json','utf8'));
    for (const entry of ['scripts/pair-android.mjs','scripts/build-android.sh','native/android/AndroidManifest.xml','native/android/src/**/*.java']) {
        assert(manifest.files.includes(entry), `Missing package asset selection: ${entry}`);
    }
    console.log('Android setup checks passed (manual guidance; no authorization side effects; package selections).');
} finally { await rm(home, {recursive:true,force:true}); }
