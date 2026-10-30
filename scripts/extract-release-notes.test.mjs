import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractReleaseNotes } from './extract-release-notes.mjs';

const markdown = '# 更新日志\n\n## v1.2.27（2026-10-29）\n\n- 新功能\n\n## v1.2.26（2026-10-29）\n\n- 旧功能\n';
test('extracts exactly one version, including the last section', () => {
  assert.equal(extractReleaseNotes(markdown, '1.2.27'), '## v1.2.27（2026-10-29）\n\n- 新功能');
  assert.equal(extractReleaseNotes(markdown, 'v1.2.26'), '## v1.2.26（2026-10-29）\n\n- 旧功能');
});
test('missing/empty section fails rather than releasing empty notes', () => {
  assert.throws(() => extractReleaseNotes(markdown, '1.2.2'), /缺少/);
  assert.throws(() => extractReleaseNotes('## v1.2.27（2026-10-29）\n', '1.2.27'), /不能为空/);
});
test('stops at a non-version level-two heading too', () => {
  assert.equal(extractReleaseNotes(markdown.split('## v1.2.26')[0] + '## 参考\n- Other', '1.2.27'), '## v1.2.27（2026-10-29）\n\n- 新功能');
});
test('CLI writes multiline output; missing section and mismatched tag exit nonzero', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-notes-'));
  try {
    mkdirSync(join(cwd, 'apps/desktop/src-tauri'), { recursive: true });
    writeFileSync(join(cwd, 'apps/desktop/src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.27' }));
    writeFileSync(join(cwd, 'CHANGELOG.md'), markdown);
    const output = join(cwd, 'output');
    const run = tag => spawnSync(process.execPath, [resolve('scripts/extract-release-notes.mjs')], { cwd, env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(run('v1.2.27').status, 0);
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    const delimiter = lines[0].slice('body<<'.length);
    assert.equal(lines.at(-1), delimiter);
    assert.equal(lines.slice(1, -1).join('\n'), extractReleaseNotes(markdown, '1.2.27'));
    assert.equal(run('v1.2.26').status, 1);
    writeFileSync(join(cwd, 'CHANGELOG.md'), '# empty');
    const missing = run('v1.2.27');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /缺少 v1.2.27/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
