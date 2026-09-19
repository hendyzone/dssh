"""Run on POSIX: python3 -m unittest discover -s tests -p '*_remote_test.py'."""
import concurrent.futures
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'src-tauri/src/team_members.py'


class RosterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def call(self, operation, payload=''):
        return subprocess.run([sys.executable, str(SCRIPT), 'demo', operation, payload], cwd=self.temp.name, capture_output=True, text=True)

    def member(self, i):
        return dict(project='demo', email=f'w{i}@example.test', role=f'worker-{i}', host='remote', port=22, username='dev', workdir='/repo', tmux=dict(id='$1', created=123, name='worker'))

    def test_read_is_non_mutating(self):
        self.assertEqual(json.loads(self.call('members').stdout), [])
        self.assertEqual(list(pathlib.Path(self.temp.name).iterdir()), [])

    def test_concurrent_clients_keep_each_others_members(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.call('memberSave', json.dumps(self.member(i))), range(20)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(self.call('members').stdout)), 20)
        replacement = self.member(1)
        replacement['host'] = 'new-host'
        replacement['password'] = 'not-exported'
        data = json.loads(self.call('memberSave', json.dumps(replacement)).stdout)
        self.assertEqual(len(data), 20)
        self.assertNotIn('not-exported', json.dumps(data))
        self.assertEqual(next(m for m in data if m['email'] == replacement['email'])['host'], 'new-host')
        self.assertEqual(len(json.loads(self.call('memberRemove', replacement['email']).stdout)), 19)

    def test_invalid_registration_does_not_overwrite_roster(self):
        original = self.call('memberSave', json.dumps(self.member(1))).stdout
        invalid = self.member(2)
        invalid['project'] = 'other'
        self.assertNotEqual(self.call('memberSave', json.dumps(invalid)).returncode, 0)
        self.assertEqual(self.call('members').stdout, original)

    def test_members_without_mail_keep_identity_when_their_terminal_changes(self):
        data = self.member(1)
        data.update(email='', id='member-example-123')
        saved = self.call('memberSave', json.dumps(data))
        self.assertEqual(saved.returncode, 0, saved.stderr)
        data['tmux']['created'] = 456
        updated = json.loads(self.call('memberSave', json.dumps(data)).stdout)
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]['tmux']['created'], 456)
        self.assertEqual(json.loads(self.call('memberRemove', data['id']).stdout), [])

    def test_batch_merges_notes_and_rejects_invalid_batches_atomically(self):
        old = self.member(0)
        old.update(responsibilities='后端 API', quota='未知', currentTask='T12 验证中', notes='使用独立 worktree\n待验收')
        self.assertEqual(self.call('memberSave', json.dumps(old)).returncode, 0)
        batch = [self.member(0), self.member(1)]
        batch[0]['host'] = 'migrated'
        batch[1]['responsibilities'] = '前端'
        target = pathlib.Path(self.temp.name) / 'batch.json'
        target.write_text(json.dumps(batch), encoding='utf-8')
        result = self.call('memberBatch', '@' + str(target))
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0]['notes'], old['notes'])
        self.assertEqual(data[0]['host'], 'migrated')
        before = self.call('members').stdout
        invalid = [self.member(2), {**self.member(3), 'quota': ['not text']}]
        self.assertNotEqual(self.call('memberBatch', json.dumps(invalid)).returncode, 0)
        self.assertEqual(self.call('members').stdout, before)
        self.assertNotEqual(self.call('memberBatch', json.dumps([old, old])).returncode, 0)
        patch = dict(project='demo', email=old['email'], quota='剩余约 30%，人工确认', notes='', host='must-not-change')
        updated = json.loads(self.call('memberNotes', json.dumps(patch)).stdout)
        self.assertEqual(updated[0]['host'], 'migrated')
        self.assertEqual(updated[0]['notes'], '')
        self.assertEqual(updated[0]['currentTask'], 'T12 验证中')
        self.assertEqual(updated[0]['quota'], patch['quota'])


if __name__ == '__main__':
    unittest.main()
