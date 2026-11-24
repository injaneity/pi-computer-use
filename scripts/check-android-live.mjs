#!/usr/bin/env node
// Opt-in acceptance test. Operates only on the companion's harmless fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

if (process.env.PI_CU_ANDROID_LIVE !== '1') {
    console.log('SKIP Android live checks (PI_CU_ANDROID_LIVE=1, paired companion fixture required).');
    process.exit(0);
}
assert.equal(process.platform, 'android', 'Run on the same Android device in Termux.');
const { default: register } = await import('../extensions/computer-use.ts');
const { shutdownComputerUseSession } = await import('../src/bridge.ts');
const { AndroidHelperClient } = await import('../src/platform/android/helper.ts');
const tools = new Map();
register({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
const ctx = { cwd: process.cwd(), hasUI: false };
const client = new AndroidHelperClient();
const flatten = root => [root, ...(root.children ?? []).flatMap(flatten)];
const stateId = result => result.details.capture.stateId;
const nodes = result => flatten(result.details.outline.root);
const node = (result, id) => {
    const found = nodes(result).find(item => item.identifier === `dev.picomputeruse:id/${id}`);
    assert(found, `Fixture node ${id} must exist`); return found;
};
const call = async (name, params) => {
    const result = await tools.get(name).execute(`android-live-${name}`, params, undefined, undefined, ctx);
    assert(!result.isError, `${name} returned an error`);
    return result;
};
const fixture = async () => {
    const roots = (await client.command('listRoots')).roots;
    const root = roots.find(item => item.bundleId === 'dev.picomputeruse' && item.isFocused);
    assert(root, 'Open the safe test page manually. No other app will be inspected.');
    const look = await client.command('look', { rootRef: root.rootRef, includeImage: false });
    assert(flatten(look.outline).some(item => item.value === 'Pi Computer Use test page'), 'Fixture marker missing: stop.');
    return { root, look };
};
try {
    await fixture();
    const found = await call('find_roots', { bundleId: 'dev.picomputeruse' });
    const root = found.details.windows.find(item => item.isFocused && item.bundleId === 'dev.picomputeruse');
    assert(root, 'find_roots must discover the focused fixture');
    let observed = await call('observe_ui', { root: root.windowRef, mode: 'semantic', detail: 'outline' });
    assert(nodes(observed).some(item => item.value === 'Pi Computer Use test page'));
    assert.equal(observed.details.target.pid, undefined, 'No fabricated Android target PID');
    console.log('PASS public find_roots + semantic observe_ui, package identity');

    const historicalState = observed;
    const inputBefore = node(observed, 'fixture_input');
    const historical = await call('read_text', { stateId: stateId(observed), ref: inputBefore.ref });
    await call('search_ui', { stateId: stateId(observed), text: 'Save test message' });
    await call('inspect_ui', { stateId: stateId(observed), ref: inputBefore.ref });
    await call('expand_ui', { stateId: stateId(observed), ref: observed.details.outline.root.ref, depth: 2 });
    console.log('PASS public search_ui, inspect_ui, expand_ui, read_text');

    observed = await call('observe_ui', { root: root.windowRef, mode: 'visual' });
    const screenshot = observed.content.find(item => item.type === 'image');
    assert(screenshot, 'Window screenshot must be available on the fixture');
    assert(observed.details.capture.width > 0 && observed.details.capture.height > 0);
    await mkdir('tmp/android-support', { recursive: true });
    await writeFile('tmp/android-support/fixture.jpg', Buffer.from(screenshot.data, 'base64'));
    console.log(`PASS screenshot ${observed.details.capture.width}x${observed.details.capture.height}`);

    const text = `Pi Android 验证 ${Date.now()}`;
    const base = observed;
    await fixture();
    const entered = await call('act_ui', { stateId: stateId(base), actions: [{ action: 'setText', ref: node(base, 'fixture_input').ref, text }], expect: { ref: node(base, 'fixture_input').ref, value: text, timeoutMs: 2000 } });
    assert.equal(entered.details.status, 'ok', JSON.stringify(entered.details));
    assert.equal(entered.details.execution.outcome, 'worked', JSON.stringify(entered.details.execution));
    assert.equal(node(entered, 'fixture_input').value, text);
    assert.equal(entered.details.execution.verification.status, 'verified');
    console.log('PASS public act_ui setText + exact scoped value postcondition');

    await assert.rejects(call('act_ui', { stateId: stateId(base), actions: [{ action: 'press', ref: node(base, 'fixture_save').ref }] }), /stale/i);
    const historicalAfter = await call('read_text', { stateId: stateId(historicalState), ref: inputBefore.ref });
    assert.equal(historicalAfter.details.text, historical.details.text, 'Historical text read must remain immutable');
    console.log('PASS stale write rejected; historical read preserved');

    await fixture();
    const saved = await call('act_ui', { stateId: stateId(entered), actions: [{ action: 'press', ref: node(entered, 'fixture_save').ref }], expect: { text: `Saved: ${text}`, timeoutMs: 2000 } });
    assert.equal(saved.details.status, 'ok', JSON.stringify(saved.details));
    assert.equal(saved.details.execution.outcome, 'worked', JSON.stringify(saved.details.execution));
    assert.equal(saved.details.execution.verification.status, 'verified');
    assert.equal(node(saved, 'fixture_result').value, `Saved: ${text}`);
    console.log('PASS public act_ui press + Saved result postcondition');
    const read = await call('read_text', { stateId: stateId(saved), ref: node(saved, 'fixture_result').ref });
    assert.equal(read.details.text, `Saved: ${text}`);
    const waited = await call('wait_for', { stateId: stateId(saved), text: `Saved: ${text}`, timeoutMs: 1000 });
    assert.equal(waited.details.found, true);
    console.log('PASS public read_text + wait_for on saved result');
    console.log('Android fixture live checks passed. Screenshot: tmp/android-support/fixture.jpg');
} finally {
    client.dispose();
    await shutdownComputerUseSession();
}
