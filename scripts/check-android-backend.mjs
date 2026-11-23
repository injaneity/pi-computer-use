import assert from 'node:assert/strict';
import { createAndroidBackend, parseAndroidRoots } from '../src/platform/android/backend.ts';
import { REQUIRED_PLATFORM_INVARIANTS } from '../src/platform/architecture.ts';

const root = (pkg, id, focused) => ({kind: 'window', rootRef: `android:session:${id}`, windowId: id, bundleId: pkg, appName: pkg,
    title: pkg, framePoints: {x:0,y:0,w:1080,h:2400}, zOrder: -id, isOnscreen: true, isFocused: focused, isMain: focused, metadata:{androidWindowType:1}});
const all = {roots:[root('one', 1, true), root('two', 2, false)]};
let invariants = [...REQUIRED_PLATFORM_INVARIANTS];
const calls = [];
let disposed = false;
const transport = {
    async command(cmd, args) {
        calls.push({cmd,args});
        switch (cmd) {
            case 'diagnostics': return {protocolVersion:1, architectureVersion:1, pid:123, os:'android', accessibility:true, invariants};
            case 'listRoots': return all;
            case 'look': return {lookId:'look:1', capturedAt:1, window:{windowId:1, rootRef:'android:session:1'}, outline:{ref:'owned:0',role:'AXWindow',children:[]}, timings:{}};
            case 'act': return {outcome:'unknown', evidence:{delivered:true}};
            case 'actBatch': return {outcome:'unknown',steps:[{outcome:'worked'},{outcome:'unknown'}],stoppedAt:1};
            case 'readText': return {text:'fixture', offset:0,limit:7,totalChars:7,hasMore:false};
            case 'waitFor': return {found:true};
            default: throw new Error(cmd);
        }
    },
    dispose() { disposed = true; },
};
const backend = createAndroidBackend(transport);
assert.equal(backend.name, 'android');
assert.equal((await backend.ensureReady({}, {lastPermissionCheckAt:0})).helperDiagnostics.os, 'android');
invariants = []; await assert.rejects(backend.ensureReady({}, {lastPermissionCheckAt:0}), /contract/); invariants = [...REQUIRED_PLATFORM_INVARIANTS];
assert.equal((await backend.listApps()).length, 2);
assert((await backend.listApps()).every(app => app.pid === undefined), 'no fabricated PID');
assert.deepEqual((await backend.listRoots({bundleId:'two'})).map(root => root.bundleId), ['two']);
assert.deepEqual(await backend.listRoots({pid:42}), []);
assert.equal((await backend.getFrontmost()).bundleId, 'one');
assert.equal((await backend.focusWindow({rootRef:'android:session:2'})).focused, false);
assert.equal((await backend.observe({target:{rootRef:'android:session:1'},readText:'never',includeImage:false})).parsedOutline.nodes.length, 1);
await assert.rejects(backend.observe({target:{pid:1},readText:'never'}), /rootRef/);
assert.equal((await backend.act({lookId:'look:1',action:'press',target:{ref:'owned:0'},policy:'default',params:{}})).outcome, 'unknown');
assert.equal((await backend.actBatch([])).stoppedAt, 1);
assert.equal((await backend.readText({lookId:'look:1',elementRef:'owned:0',offset:0,limit:7})).text, 'fixture');
assert.equal((await backend.waitFor({rootRef:'android:session:1',gone:false,timeoutMs:1000})).found, true);
assert(backend.isBrowserApp('Chrome','com.android.chrome'));
await assert.rejects(backend.openBrowserLocation({appName:'Chrome'},'https://example.com'), /not implemented/);
assert.throws(() => parseAndroidRoots({roots:[{...all.roots[0],rootRef:''}]}), /identity/);
assert.throws(() => parseAndroidRoots({roots:[{...all.roots[0],framePoints:{x:0,y:0,w:NaN,h:1}}]}), /number/);
await backend.shutdown(); assert(disposed);

// Read-only recapture may stabilize an in-flight UI update. Input is never replayed.
const changed = Object.assign(new Error('observation_changed: capture raced UI update'), {code:'observation_changed'});
const request = {target:{rootRef:'android:session:1'},readText:'never',includeImage:false};
let attempts = 0;
const settling = createAndroidBackend({dispose(){},async command(cmd,args) {
    attempts++;
    if (attempts === 1) throw changed;
    return transport.command(cmd,args);
}});
assert.equal((await settling.observe(request)).lookId, 'look:1');
assert.equal(attempts, 2);
let unstableAttempts = 0;
const unstable = createAndroidBackend({dispose(){},async command(){unstableAttempts++;throw changed;}});
await assert.rejects(unstable.observe(request), /observation_changed/);
assert.equal(unstableAttempts, 3, 'Read-only recaptures must be bounded');
unstableAttempts = 0;
await assert.rejects(unstable.act({lookId:'look:1',action:'press',target:{ref:'owned:0'},policy:'default',params:{}}), /observation_changed/);
assert.equal(unstableAttempts, 1, 'Never replay input even on observation_changed');
let failedAttempts = 0;
const failed = createAndroidBackend({dispose(){},async command(){failedAttempts++;throw new Error('disconnected');}});
await assert.rejects(failed.observe(request), /disconnected/);
assert.equal(failedAttempts, 1, 'Do not mask service or transport failures');
const abort = new AbortController();
let abortedAttempts = 0;
const cancelled = createAndroidBackend({dispose(){},async command(){abortedAttempts++;abort.abort();throw changed;}});
await assert.rejects(cancelled.observe(request, {signal:abort.signal}));
assert.equal(abortedAttempts, 1);

// The native wait loop caps at 25 s. Callers must see the bound that was applied.
const waitArgs = [];
const waiting = createAndroidBackend({dispose(){},async command(cmd,args){
    waitArgs.push({cmd,args});
    return {found:false, timedOut:true, nodeCount:3};
}});
const longWait = await waiting.waitFor({rootRef:'android:session:1',gone:false,timeoutMs:60000});
assert.equal(longWait.found, false);
assert.equal(longWait.timedOut, true);
assert.equal(longWait.timeoutMs, 25000, 'Clamped wait must report the applied bound');
assert.equal(waitArgs.at(-1).args.timeoutMs, 25000, 'Clamped wait must not request more than the native loop allows');
assert.equal((await waiting.waitFor({rootRef:'android:session:1',gone:false,timeoutMs:1500})).timeoutMs, 1500);
assert.equal(waitArgs.at(-1).args.timeoutMs, 1500, 'A short wait keeps the requested bound');
console.log('Android backend contract checks passed.');
