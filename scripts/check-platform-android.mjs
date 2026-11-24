import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AndroidHelperClient } from '../src/platform/android/helper.ts';

const secret = randomBytes(32).toString('hex');
const proof = (role, nonce) => createHmac('sha256', secret).update(`pi-cu-android-v1:${role}:${nonce}`).digest('hex');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cu-android-'));
const credentialPath = path.join(dir, 'android.json');
const sockets = new Set();
let dispatched = 0;
let badServer = false;
const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); let buffer = ''; let phase = 0; const nonce = randomBytes(32).toString('hex');
    socket.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
            const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            assert(!raw.includes(secret), 'secret must not be transmitted');
            const request = JSON.parse(raw);
            const send = data => socket.write(JSON.stringify(data) + '\n');
            if (phase === 0) {
                phase++;
                send({protocolVersion: 1, nonce, proof: badServer ? '0'.repeat(64) : proof('server', request.nonce)});
            } else if (phase === 1) {
                assert.equal(request.proof, proof('client', nonce)); phase++; send({authenticated: true});
            } else {
                dispatched++;
                if (request.cmd === 'disconnect') { socket.destroy(); continue; }
                if (request.cmd === 'hang') continue;
                if (request.cmd === 'malformed') { socket.write('not-json\n'); continue; }
                if (request.cmd === 'wrong-id') { send({protocolVersion: 1, id: request.id + 1, ok: true, result: {}}); continue; }
                if (request.cmd === 'error') { send({protocolVersion: 1, id: request.id, ok: false, error: {code: 'stale_state', message: 'Observe again'}}); continue; }
                send({protocolVersion: 1, id: request.id, ok: true, result: request.args});
            }
        }
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await fs.writeFile(credentialPath, JSON.stringify({port: server.address().port, secret}), {mode: 0o600});
const client = new AndroidHelperClient({credentialPath});
try {
    assert.deepEqual(await client.command('echo', {unicode: '你好🙂'}), {unicode: '你好🙂'});
    assert.deepEqual(await Promise.all([1,2,3].map(n => client.command('echo', {n}))), [{n:1},{n:2},{n:3}]);
    await assert.rejects(client.command('error'), error => error.code === 'stale_state');
    let start = dispatched;
    await assert.rejects(client.command('disconnect'), /closed|disconnected/i);
    assert.equal(dispatched, start + 1, 'disconnected actions must never be replayed');
    await assert.rejects(client.command('hang', {}, {timeoutMs: 100}), /timed out/i);
    await assert.rejects(client.command('malformed'), /protocol|JSON/i);
    await assert.rejects(client.command('wrong-id'), /protocol|id/i);
    const controller = new AbortController(); controller.abort(); start = dispatched;
    await assert.rejects(client.command('echo', {}, {signal: controller.signal}), /abort/i);
    assert.equal(dispatched, start, 'aborted request must not dispatch');
    badServer = true; start = dispatched;
    await assert.rejects(client.command('echo'), /authentication/i);
    assert.equal(dispatched, start, 'untrusted server receives no command');
    badServer = false;
    await fs.chmod(credentialPath, 0o644);
    await assert.rejects(client.command('echo'), /permission|0600/i);
    await fs.chmod(credentialPath, 0o600);
    await fs.writeFile(credentialPath, JSON.stringify({port: 70000, secret}));
    await assert.rejects(client.command('echo'), /port/i);
    client.dispose();
    await assert.rejects(client.command('echo'), /closed/i);
    console.log('Android transport checks passed (auth, concurrency, abort, timeout, no replay, validation).');
} finally {
    client.dispose(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await fs.rm(dir, {recursive: true, force: true});
}
