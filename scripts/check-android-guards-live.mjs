#!/usr/bin/env node
// Opt-in native guard acceptance. Only the companion's harmless fixture is allowed.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AndroidHelperClient } from '../src/platform/android/helper.ts';
import { createAndroidBackend } from '../src/platform/android/backend.ts';

if (process.env.PI_CU_ANDROID_LIVE !== '1') {
    console.log('SKIP Android guard live checks (PI_CU_ANDROID_LIVE=1 required).');
    process.exit(0);
}
assert.equal(process.platform, 'android');
const client = new AndroidHelperClient();
const backend = createAndroidBackend(client);
const fixture = async (image = false) => {
    const roots = await backend.listRoots({bundleId:'dev.picomputeruse'});
    const root = roots.find(item => item.isFocused);
    assert(root, 'Open the safe test page manually. Stop without inspecting another app.');
    const look = await backend.observe({target:{rootRef:root.rootRef},readText:'never',includeImage:image});
    assert(look.parsedOutline.nodes.some(item => item.value === 'Pi Computer Use test page'), 'Fixture marker missing; stop.');
    return look;
};
const ref = (look, id) => {
    const node = look.parsedOutline.nodes.find(item => item.identifier === `dev.picomputeruse:id/${id}`);
    assert(node, `Missing fixture ${id}`); return node.wireRef;
};
const action = (look, id, name, params = {}, policy = 'default') => ({lookId:look.lookId,action:name,target:{ref:ref(look,id)},params,policy});
const rejectCode = async (promise, code) => await assert.rejects(promise, error => error.code === code, `Expected ${code}`);
try {
    let look = await fixture();
    const second = await fixture();
    await rejectCode(client.command('readText',{lookId:second.lookId,elementRef:ref(look,'fixture_input')}), 'stale_element');
    await rejectCode(client.command('act',action(look,'fixture_input','setText',{text:'must not be written'},'ax_only')), 'foreground_required');
    await rejectCode(client.command('act',action(look,'fixture_input','keypress',{keys:['ENTER']})), 'unsupported_operation');
    await rejectCode(client.command('act',{lookId:look.lookId,action:'click',target:{x:1,y:1},params:{},policy:'default'}), 'image_required');
    console.log('PASS native ref ownership, headless/unsupported input, image-required guards');

    const value = `Batch 验证 ${Date.now()}`;
    const result = await client.command('actBatch',{actions:[
        action(look,'fixture_input','setText',{text:value}),
        action(look,'fixture_save','press'),
        action(look,'fixture_input','setText',{text:'MUST NOT RUN'}),
    ]});
    assert.equal(result.outcome,'unknown');
    assert.equal(result.steps.length,2);
    assert.equal(result.steps[0].outcome,'worked');
    assert.equal(result.steps[1].outcome,'unknown');
    assert.equal(result.stoppedAt,1);
    await rejectCode(client.command('act',action(look,'fixture_save','press')), 'stale_state');
    const after = await fixture();
    const input = after.parsedOutline.nodes.find(item => item.identifier.endsWith('/fixture_input'));
    const saved = after.parsedOutline.nodes.find(item => item.identifier.endsWith('/fixture_result'));
    assert.equal(input.value,value);
    assert.equal(saved.value,`Saved: ${value}`);
    console.log('PASS native batch stops at uncertain press; third action not delivered; old writes stale');

    // A queued mutation must not run after its client cancels. The wait holds the native device lane.
    look = await fixture();
    const blocker = client.command('waitFor',{rootRef:look.window.rootRef,text:'nonexistent fixture blocker',gone:false,timeoutMs:600},{timeoutMs:2000});
    await delay(100);
    const abort = new AbortController();
    const queued = client.command('act',action(look,'fixture_input','setText',{text:'MUST NOT RUN AFTER CANCEL'}),{signal:abort.signal});
    await delay(100); abort.abort();
    await assert.rejects(queued,/aborted/);
    assert.equal((await blocker).found,false);
    const unchanged = await fixture();
    assert.equal(unchanged.parsedOutline.nodes.find(item=>item.identifier.endsWith('/fixture_input')).value,value);
    console.log('PASS cancelled queued mutation does not run after device lane becomes free');

    look = await fixture(true);
    assert(look.image);
    await rejectCode(client.command('act',{lookId:look.lookId,action:'click',target:{x:look.image.width,y:1},params:{},policy:'default'}), 'invalid_coordinates');
    await rejectCode(client.command('act',{lookId:look.lookId,action:'click',target:{x:-1,y:1},params:{},policy:'default'}), 'invalid_coordinates');
    // The title can sit under an edge-to-edge status bar. Touch a noninteractive content row instead.
    const row = look.parsedOutline.nodes.find(item=>item.value==='Test row 1');
    assert(row.rect?.w > 0 && row.rect?.h > 0);
    const x = row.rect.x + row.rect.w/2, y = row.rect.y + row.rect.h/2;
    const roots = await backend.listRoots({});
    const own = roots.find(item=>item.rootRef===look.window.rootRef);
    assert(own?.isFocused, 'Fixture must still be focused before the touch');
    const sx = own.framePoints.x + x * own.framePoints.w / look.image.width;
    const sy = own.framePoints.y + y * own.framePoints.h / look.image.height;
    for (const other of roots.filter(item=>item.rootRef!==own.rootRef && item.zOrder < own.zOrder)) {
        const r = other.framePoints;
        assert(!(sx>=r.x-1 && sy>=r.y-1 && sx<=r.x+r.w+1 && sy<=r.y+r.h+1), 'Fixture test point is obscured; stop without input');
    }
    const tap = await client.command('act',{lookId:look.lookId,action:'click',target:{x,y},params:{},policy:'default'});
    assert.equal(tap.outcome,'unknown');
    assert.equal(tap.performed?.delivery,'hid',JSON.stringify(tap));
    assert.equal(tap.evidence.delivered,true,JSON.stringify(tap));
    console.log('PASS screenshot-coordinate bounds + physical tap; delivered gesture remains unknown');
    console.log('Android native guard live checks passed.');
} finally { await backend.shutdown(); }
