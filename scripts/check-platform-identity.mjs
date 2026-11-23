import assert from 'node:assert/strict';
import { appIdentity, resourceKeyForTarget, rootIdentity } from '../src/platform/identity.ts';

assert.equal(appIdentity({ pid: 42, bundleId: 'app' }), 'pid:42');
assert.equal(appIdentity({ bundleId: 'dev.example' }), 'app:dev.example');
assert.throws(() => appIdentity({}), /identity/i);
assert.equal(resourceKeyForTarget('linux', { pid: 42 }), 'desktop-pid:42');
assert.equal(resourceKeyForTarget('macos', { pid: 42 }), 'desktop-pid:42');
assert.equal(resourceKeyForTarget('android', { bundleId: 'one' }), 'android-device:local');
assert.equal(resourceKeyForTarget('android', { bundleId: 'two' }), 'android-device:local');
assert.throws(() => resourceKeyForTarget('linux', {}), /pid/i);
const root = { pid: 42, windowId: 7, nativeWindowRef: 'native', windowTitle: 'title', framePoints: {x: 0, y: 0, w: 1, h: 1} };
assert.equal(rootIdentity('macos', root), 'pid:42|id:7');
assert.notEqual(rootIdentity('android', {...root, pid: undefined, nativeWindowRef: 'android:session1:window7'}), rootIdentity('android', {...root, pid: undefined, nativeWindowRef: 'android:session2:window7'}));
assert.throws(() => rootIdentity('android', {...root, pid: undefined, nativeWindowRef: undefined}), /root/i);
console.log('Platform identity checks passed.');
