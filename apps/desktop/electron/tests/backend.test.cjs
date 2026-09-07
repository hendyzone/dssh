const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const fixture = `
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', line => {
  const r = JSON.parse(line);
  if (r.command === 'servers_list') {
    process.stdout.write('{"event":"ssh://test/data","payload":"中');
    setTimeout(() => { process.stdout.write('文"}\\n'); send({id:r.id,result:[]}); }, 5);
  } else if (r.command === 'ssh_write') {
    setTimeout(() => send({id:r.id,result:r.args.data}), r.args.data === 'first' ? 25 : 0);
  } else if (r.command === 'sync_test') {
    // Deliberately pending, to test process failure cleanup.
  } else send({id:r.id,error:'synthetic failure'});
});`;

function createBackend() {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../backend.cjs'), 'utf8'), {
    module, process, console,
    require(name) {
      if (name === 'node:child_process') return { spawn: (_exe, _args, options) => spawn(process.execPath, ['-e', fixture], options) };
      if (name === './commands.json') return require('../commands.json');
      return require(name);
    },
  });
  return new module.exports.Backend('fixture', __dirname);
}

test('matches split UTF-8 events and responses, rejects errors and unknown commands', async t => {
  const backend = createBackend(); t.after(() => backend.stop());
  const events = [];
  backend.on('event', (...args) => events.push(args));
  assert.deepEqual(Array.from(await backend.call('servers_list')), []);
  assert.deepEqual(events, [['ssh://test/data', '中文']]);
  await assert.rejects(backend.call('not_allowed'), /Unknown command/);
  await assert.rejects(backend.call('sftp_home', {sessionId:'missing'}), /synthetic failure/);
});

test('orders writes within each session and rejects pending/future calls on process exit', async t => {
  const backend = createBackend(); t.after(() => backend.stop());
  const completed = [];
  await Promise.all(['first','second'].map(data => backend.call('ssh_write', { sessionId:'test', data }).then(value => completed.push(value))));
  assert.deepEqual(completed, ['first','second']);
  const pending = backend.call('sync_test');
  const rejected = assert.rejects(pending, /后台已退出/);
  backend.child.kill();
  await rejected;
  await assert.rejects(backend.call('servers_list'), /后台已退出/);
  assert.equal(backend.pending.size, 0);
});

test('Rust and Electron expose the same backend commands', () => {
  const rust = readFileSync(path.join(__dirname, '../../backend/src/dispatch.rs'), 'utf8');
  const dispatched = [...rust.matchAll(/"(\w+)" => encode/g)].map(match => match[1]).sort();
  assert.deepEqual(dispatched, [...require('../commands.json')].sort());
});
