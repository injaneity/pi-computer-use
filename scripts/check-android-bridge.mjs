#!/usr/bin/env node
import assert from 'node:assert/strict';
import { currentPlatformBackend } from '../src/platform/index.ts';
import { parseLookResponse } from '../src/outline.ts';
import { executeFind, executeObserve, executeAct, executeReadText, shutdownComputerUseSession } from '../src/bridge.ts';

const original = { ...currentPlatformBackend };
const ctx = { cwd: process.cwd(), hasUI: false };
const call = (fn, args) => fn('fixture', args, undefined, undefined, ctx);
const root = { kind: 'window', rootRef: 'android:test-session:1:10', windowRef: 'android:test-session:1:10', windowId: 10,
    appName: 'fixture', bundleId: 'dev.fixture', title: 'Fixture', zOrder: 0, framePoints: {x:0,y:0,w:100,h:100},
    scaleFactor: 1, isFocused: true, isMain: true, isMinimized: false, isOnscreen: true, isModal: false };
const snapshots = new Map();
let sequence = 0;
let value = 'before';
let writes = 0;
let partialBatch = false;
Object.assign(currentPlatformBackend, {
    name: 'android', capabilities: { ocr: false, scopedRefresh: false, nativeTransactions: true, snapshotText: true },
    async ensureReady(_ctx, state) { return state; },
    async listApps() { return [{appName:'fixture', bundleId:'dev.fixture'}]; },
    async listRoots() { return [root]; },
    async focusWindow() { return { focused: true }; },
    async observe() {
        const id = `look:${++sequence}`;
        snapshots.set(id, value);
        return parseLookResponse({ lookId: id, capturedAt: Date.now()/1000, window: { ...root, isModal:false, role:'AXWindow', subrole:'' },
            outline: {ref:`${id}:root`,role:'AXWindow',children:[{ref:`${id}:input`,identifier:'fixture-input',role:'AXTextField',isTextInput:true,canSetValue:true,value}]}, timings:{} });
    },
    async actBatch(requests) {
        writes++;
        value = requests[0].params.text;
        return { outcome:partialBatch?'unknown':'worked', steps: [{outcome:partialBatch?'unknown':'worked',performed:{delivery:'ax'}}], stoppedAt:partialBatch?0:undefined, performed:{actionCount:1,transaction:true} };
    },
    async waitFor() { return {found:true}; },
    async readText({lookId, offset, limit}) { const text = snapshots.get(lookId); return {text:text.slice(offset,offset+limit),offset,limit,totalChars:text.length,hasMore:false}; },
    isBrowserApp() { return false; }, isChromeFamilyApp() { return false; }, shutdown() {},
});
try {
    const found = await call(executeFind, {bundleId:'dev.fixture'});
    const base = await call(executeObserve, {root:found.details.windows[0].windowRef,mode:'semantic'});
    const input = base.details.outline.root.children[0];
    const stateId = base.details.capture.stateId;
    assert.equal((await call(executeReadText, {stateId,ref:input.ref})).details.text, 'before');
    const next = await call(executeAct, {stateId,actions:[{action:'setText',ref:input.ref,text:'after'}]});
    assert.equal(next.details.status, 'ok');
    assert.equal((await call(executeReadText, {stateId:next.details.capture.stateId,ref:input.ref})).details.text, 'after');
    await assert.rejects(call(executeAct, {stateId,actions:[{action:'setText',ref:input.ref,text:'stale'}]}), /stale/i);
    assert.equal(writes, 1, 'Old-state write must not reach the backend');
    assert.equal((await call(executeReadText, {stateId,ref:input.ref})).details.text, 'before', 'Snapshot text stays readable after a write');
    currentPlatformBackend.capabilities.snapshotText = false;
    await assert.rejects(call(executeReadText, {stateId,ref:input.ref}), /stale/i, 'Live-read backends keep their epoch guard');
    const latest = await call(executeObserve, {root:found.details.windows[0].windowRef,mode:'semantic'});
    partialBatch = true;
    const partial = await call(executeAct, {stateId:latest.details.capture.stateId,actions:[
        {action:'setText',ref:input.ref,text:'partial'},
        {action:'setText',ref:input.ref,text:'unexecuted'},
    ], expect:{text:'partial',timeoutMs:100}});
    assert.equal(partial.details.execution.verification.status,'verified');
    assert.equal(partial.details.execution.actionCount,1);
    assert.equal(partial.details.execution.stoppedAt,0);
    assert.equal(partial.details.execution.outcome,'unknown','A verified prefix must not mark an incomplete transaction worked');
    assert.equal(value,'partial','Unexecuted suffix must not run');
    console.log('Android public bridge checks passed (history, stale write, live-read guard, partial batch).');
} finally {
    await shutdownComputerUseSession();
    Object.assign(currentPlatformBackend, original);
}
