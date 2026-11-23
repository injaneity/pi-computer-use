#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Pair manually in the APK. Never enable AccessibilityService through adb/settings.
const directory = path.join(homedir(), '.config', 'pi-computer-use');
const file = path.join(directory, 'android.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ port: 39871, secret: randomBytes(32).toString('hex') }) + '\n'); }
    finally { await handle.close(); }
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('Existing credential file kept. If you revoked pairing in the APK, delete it first to generate a new secret.');
}
if (((await stat(file)).mode & 0o077) !== 0) throw new Error(`Credential permissions must be 0600: ${file}`);
const config = JSON.parse(await readFile(file, 'utf8'));
if (!/^[0-9a-f]{64}$/.test(config.secret)) throw new Error('Invalid pairing secret. Revoke the old pairing before creating a replacement.');
if (process.argv.includes('--clipboard')) {
    const result = spawnSync('termux-clipboard-set', [], { input: config.secret, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'ignore', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error('Clipboard unavailable. Run this script interactively with --show instead.');
    console.log('Pairing secret copied to clipboard. Paste it into Pi Computer Use and confirm pairing.');
} else if (process.argv.includes('--show') && process.stdout.isTTY) {
    console.log(config.secret);
} else {
    console.log('Credentials saved privately. Use --clipboard (Termux) or --show in a private interactive terminal.');
}
console.log(`Credential file: ${file}`);
