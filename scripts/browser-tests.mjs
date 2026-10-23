import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const relayRoot = '/workspace/.cache/closer-turn';
const testEnv = { ...process.env };
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const exists = path => access(path).then(() => true, () => false);
const ready = port => new Promise((resolve, reject) => {
  const deadline = Date.now() + 7000;
  const attempt = () => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', () => { socket.destroy(); if (Date.now() > deadline) reject(new Error('The local test relay could not start.')); else setTimeout(attempt, 100); });
  }; attempt();
});
let relay, directory, runner;
async function cleanup() {
  if (relay && relay.exitCode === null) { relay.kill('SIGTERM'); await new Promise(resolve => { relay.once('exit', resolve); setTimeout(resolve, 2000).unref(); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => runner?.kill('SIGINT'));
process.on('SIGTERM', () => runner?.kill('SIGTERM'));
try {
  testEnv.CLOSER_TEST_PORT = String(await freePort());
  testEnv.PUBLIC_ORIGIN = `http://127.0.0.1:${testEnv.CLOSER_TEST_PORT}`;
  const binary = process.env.TEST_TURN_BIN || `${relayRoot}/usr/bin/turnserver`;
  if (!testEnv.TURN_URL && await exists(binary)) {
    directory = await mkdtemp(join(tmpdir(), 'closer-relay-'));
    const port = await freePort();
    const password = randomBytes(24).toString('base64url');
    const config = [
      'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1', `listening-port=${port}`,
      'min-port=49000', 'max-port=49100', 'realm=closer-test.local',
      'fingerprint', 'lt-cred-mech', `user=integration:${password}`,
      'no-cli', 'no-tls', 'no-dtls', 'no-multicast-peers', 'allow-loopback-peers',
      'no-tcp-relay', 'relay-threads=1', 'simple-log',
      `userdb=${directory}/users.sqlite`, `pidfile=${directory}/relay.pid`, `log-file=${directory}/relay.log`
    ].join('\n') + '\n';
    const path = join(directory, 'relay.conf');
    await writeFile(path, config, { mode: 0o600 });
    relay = spawn(binary, ['-c', path, '--no-stdout-log'], {
      stdio: 'ignore',
      env: { ...process.env, LD_LIBRARY_PATH: `${relayRoot}/usr/lib/x86_64-linux-gnu${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}` }
    });
    let relayError;
    relay.on('error', error => { relayError = error; });
    await ready(port);
    if (relayError) throw relayError;
    testEnv.TURN_URL = `turn:127.0.0.1:${port}?transport=tcp`;
    testEnv.TURN_USERNAME = 'integration'; testEnv.TURN_CREDENTIAL = password;
    console.log('Testing camera calls through an isolated local TCP relay.');
  }
  runner = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], { cwd: root, env: testEnv, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { runner.on('error', reject); runner.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
  process.exitCode = code;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await cleanup(); }
