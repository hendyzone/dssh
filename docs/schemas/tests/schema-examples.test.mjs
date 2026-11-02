// Validates the protocol documentation's JSON examples and the activity schemas.
//
// Run with: node --test docs/schemas/tests/schema-examples.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateRef, validate, loadSchema } from './validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(HERE, '..');
const REPO = resolve(SCHEMA_DIR, '..', '..');
const PROTOCOL = join(REPO, 'docs', 'team-service-protocol.md');
const VALIDATE_CLI = join(HERE, 'validate.mjs');

// Every `<!-- schema: file.json[#/pointer] -->` marker in the protocol doc followed by a JSON fence.
function docExamples() {
  const markdown = readFileSync(PROTOCOL, 'utf8');
  const marker = /<!-- schema: ([^\s]+) -->\s*```json\n([\s\S]*?)```/g;
  const examples = [];
  for (const match of markdown.matchAll(marker)) {
    examples.push({ ref: match[1], body: match[2] });
  }
  return examples;
}

const schemaFiles = readdirSync(SCHEMA_DIR).filter(name => name.endsWith('.json'));

test('every schema file is self-contained and its local refs resolve', () => {
  for (const file of schemaFiles) {
    const { schema, root } = loadSchema(file);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${file} $schema`);
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node === null || typeof node !== 'object') return;
      if (node.$ref !== undefined) {
        assert.match(node.$ref, /^#\//, `${file}: only local $ref is allowed, got ${node.$ref}`);
        validate(undefined, { $ref: node.$ref }, root, '$', []); // throws when unresolvable
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === '$defs' || key === 'properties') Object.values(value).forEach(visit);
        else visit(value);
      }
    };
    visit(schema);
  }
});

test('every JSON example in the protocol doc matches its marker schema', () => {
  const examples = docExamples();
    let checked = 0;
  for (const { ref, body } of examples) {
    if (ref === 'none') continue; // informative example, no schema attached
    let data;
    assert.doesNotThrow(() => { data = JSON.parse(body); }, `${ref} example is not JSON:\n${body}`);
    const items = ref.endsWith('[]');
    const target = items ? ref.slice(0, -2) : ref;
    const errors = items
      ? (assert.ok(Array.isArray(data), `${ref} example must be an array`), data.flatMap(item => validateRef(item, target)))
      : validateRef(data, target);
    assert.deepEqual(errors, [], `${ref} example failed:\n${body}`);
    checked += 1;
  }
  assert.ok(checked >= 12, `expected at least 12 schema-backed examples, checked ${checked}`);
});

test('the new activity schemas appear in the doc and in the schema index', () => {
  const markdown = readFileSync(PROTOCOL, 'utf8');
  for (const name of ['activity-event.json', 'activity-state.json']) {
    assert.ok(markdown.includes(`<!-- schema: ${name} -->`), `${name} example missing from §7.6`);
    assert.ok(markdown.includes(`(schemas/${name})`), `${name} missing from the §10 index`);
  }
  assert.ok(markdown.includes('### 7.6 Worker activity files (v1)'));
});

test('activity object is optional: legacy integer and missing activity still validate', () => {
  const base = {
    agent: { version: '0.0.9', boot: '3f6c2a9e-8d41-4b7a-9c55-0e2f1a6b7c8d', seq: 7 },
    full: false,
    tmux: { server_pid: 1234, ok: true },
    panes: [
      { sid: '$3', created: 1712345678, name: 'worker-example-host-a-codex', pane: '%7', activity: 1712349999, state: 'running' },
      { sid: '$4', created: 1712345679, name: 'worker-example-host-b-codex', pane: '%8', state: 'idle' },
    ],
  };
  assert.deepEqual(validateRef(base, 'agent-report.json'), []);
});

test('a full activity object validates and its required subfields are enforced', () => {
  const report = {
    agent: { version: '0.1.0', boot: '3f6c2a9e-8d41-4b7a-9c55-0e2f1a6b7c8d', seq: 8 },
    full: false,
    tmux: { server_pid: 1234, ok: true },
    panes: [{
      sid: '$3', created: 1712345678, name: 'worker-example-host-a-dsh', pane: '%7', state: 'running',
      activity: {
        state: 'working', reason: 'Bash 7m', since: '2026-11-01T09:12:03Z',
        last_event_ts: '2026-11-01T09:14:51.612Z', last_event: 'tool_start',
        open_tool: 'Bash', open_tool_since: '2026-11-01T09:14:51.612Z',
        cpu_active: true, net_active: true, source: 'events',
      },
    }],
  };
  assert.deepEqual(validateRef(report, 'agent-report.json'), []);

  const bad = structuredClone(report);
  bad.panes[0].activity.state = 42;
  assert.notDeepEqual(validateRef(bad, 'agent-report.json'), []);

  const noSince = structuredClone(report);
  delete noSince.panes[0].activity.since;
  assert.notDeepEqual(validateRef(noSince, 'agent-report.json'), []);

  const badSource = structuredClone(report);
  badSource.panes[0].activity.source = 'screen'; // the plan says pane/screen evidence is `pane`
  assert.notDeepEqual(validateRef(badSource, 'agent-report.json'), []);
});

test('agent-side activity.state excludes offline; unattached is the agent\'s no-event-file state', () => {
  const report = {
    agent: { version: '0.1.0', boot: '3f6c2a9e-8d41-4b7a-9c55-0e2f1a6b7c8d', seq: 10 },
    full: false,
    tmux: { server_pid: 1234, ok: true },
    panes: [{
      sid: '$3', created: 1712345678, name: 'worker-example-host-a-codex', pane: '%7', state: 'idle',
      activity: { state: 'unattached', since: '2026-11-01T09:12:03Z', source: 'pane' },
    }],
  };
  for (const state of ['working', 'stalled', 'waiting_human', 'idle', 'unattached']) {
    const ok = structuredClone(report);
    ok.panes[0].activity.state = state;
    assert.deepEqual(validateRef(ok, 'agent-report.json'), [], `${state} must validate`);
  }
  const offline = structuredClone(report);
  offline.panes[0].activity.state = 'offline'; // derived by the service, never sent by an agent
  assert.notDeepEqual(validateRef(offline, 'agent-report.json'), []);
});

test('activity event v1 validates and rejects a wrong version or cross-file field', () => {
  const event = {
    v: 1, ts: '2026-11-01T09:14:51.612Z', box: 'dcollab-cw1-dsh', tool: 'dsh', ev: 'tool_start',
    pane: '%7', sid: 's_9f2c1b', turn: 't_41', name: 'Bash', pid: 4242, ok: null, detail: 'go test',
  };
  assert.deepEqual(validateRef(event, 'activity-event.json'), []);
  assert.deepEqual(validateRef(event, 'activity-state.json'), [], 'state file is the same record shape');

  for (const [field, value] of Object.entries({ v: 2, ts: 1712349999, tool: 'screen', ev: 'prompt', pane: '3', ok: 'yes' })) {
    const bad = { ...event, [field]: value };
    assert.notDeepEqual(validateRef(bad, 'activity-event.json'), [], `${field}=${JSON.stringify(value)} should fail`);
  }
  const unknown = { ...event, prompt: 'secret' };
  assert.notDeepEqual(validateRef(unknown, 'activity-event.json'), [], 'unknown fields must be rejected');
});

test('CLI exits 0 for a valid report and 1 after a required-subfield mutation', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'activity-schema-'));
  try {
    const report = {
      agent: { version: '0.1.0', boot: '3f6c2a9e-8d41-4b7a-9c55-0e2f1a6b7c8d', seq: 9 },
      full: false,
      tmux: { ok: true },
      panes: [{
        sid: '$3', created: 1712345678, name: 'worker-example-host-a-dsh', pane: '%7', state: 'running',
        activity: { state: 'waiting_human', reason: 'confirm Bash', since: '2026-11-01T09:12:03Z', source: 'events' },
      }],
    };
    const good = join(dir, 'report.json');
    writeFileSync(good, JSON.stringify(report));
    const before = spawnSync(process.execPath, [VALIDATE_CLI, 'agent-report.json', good], { encoding: 'utf8' });
    assert.equal(before.status, 0, before.stderr);

    const mutated = structuredClone(report);
    mutated.panes[0].activity.state = 42;
    const bad = join(dir, 'report-mutated.json');
    writeFileSync(bad, JSON.stringify(mutated));
    const after = spawnSync(process.execPath, [VALIDATE_CLI, 'agent-report.json', bad], { encoding: 'utf8' });
    assert.equal(after.status, 1, 'a mutated activity.state must turn validation red');
    assert.match(after.stderr, /activity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
