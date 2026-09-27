import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parents[1] / 'src-tauri' / 'src' / 'ai_status.py'
spec = importlib.util.spec_from_file_location('ai_status', SOURCE)
ai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ai)


class AiStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        for p in [patch.object(ai, 'ROOT', self.home / 'state'),
                  patch.object(ai, 'HELPER', self.home / 'share' / 'ai_status.py'),
                  patch.dict(os.environ, {'DSSH_PANE_ID': 'pane-one', 'DSSH_CONNECTION_ID': 'ssh-one', 'CLAUDE_CONFIG_DIR': str(self.home / 'claude'),
                                          'CODEX_HOME': str(self.home / 'codex'), 'PI_CODING_AGENT_DIR': str(self.home / 'pi')})]:
            p.start()
            self.addCleanup(p.stop)
        os.environ.pop('TMUX', None)

    def test_provider_lifecycle_and_no_subagent_or_idle_prompt_completion(self):
        for provider in ('claude', 'codex'):
            self.assertEqual(ai.phase_for(provider, {'hook_event_name': 'UserPromptSubmit'}), 'working')
            self.assertEqual(ai.phase_for(provider, {'hook_event_name': 'PermissionRequest'}), 'waiting')
            self.assertEqual(ai.phase_for(provider, {'hook_event_name': 'Stop'}), 'idle')
            self.assertIsNone(ai.phase_for(provider, {'hook_event_name': 'Stop', 'agent_id': 'child'}))
        self.assertIsNone(ai.phase_for('claude', {'hook_event_name': 'Notification', 'notification_type': 'idle_prompt'}))
        self.assertEqual(ai.phase_for('pi', {'hook_event_name': 'ui_prompt_start'}), 'waiting')
        self.assertEqual(ai.phase_for('pi', {'hook_event_name': 'agent_end'}), 'idle')
        self.assertIsNone(ai.phase_for('unknown', {'hook_event_name': 'Stop'}))

    def test_state_never_contains_prompt_arguments_transcript_or_answer(self):
        for provider in ai.PROVIDERS:
            ai.record_event(provider, {'hook_event_name': 'agent_start' if provider == 'pi' else 'UserPromptSubmit',
                'session_id': provider, 'prompt': 'secret-prompt', 'tool_input': 'secret-tool',
                'transcript_path': 'secret-path', 'answer': 'secret-answer'})
        self.assertEqual(len(list(ai.ROOT.glob('*.json'))), 3)
        for path in ai.ROOT.glob('*.json'):
            self.assertNotIn('secret-', path.read_text())
        self.assertEqual(len(ai.status()), 1)  # Only current activity for the same terminal.

    def test_repeated_waiting_does_not_create_a_new_revision(self):
        event = {'hook_event_name': 'PermissionRequest', 'session_id': 'one'}
        ai.record_event('codex', event)
        first = ai.status()[0]
        ai.record_event('codex', event)
        self.assertEqual(ai.status()[0]['revision'], first['revision'])
        ai.record_event('codex', {**event, 'hook_event_name': 'PostToolUse'})
        self.assertEqual(ai.status()[0]['phase'], 'working')

    def test_install_is_idempotent_and_removal_preserves_user_hooks_and_settings(self):
        for provider, filename in [('claude', 'settings.json'), ('codex', 'hooks.json')]:
            path = self.home / provider / filename
            path.parent.mkdir()
            user = {'theme': 'dark', 'hooks': {'Stop': [{'matcher': 'custom', 'hooks': [{'type': 'command', 'command': 'my-notifier'}]}]}}
            path.write_text(json.dumps(user))
            ai.install(provider)
            installed = json.loads(path.read_text())
            ai.install(provider)
            self.assertEqual(installed, json.loads(path.read_text()))
            self.assertEqual(installed['hooks']['Stop'][0], user['hooks']['Stop'][0])
            self.assertTrue(list(path.parent.glob(filename + '.dssh-backup-*')))
            ai.install(provider, remove=True)
            self.assertEqual(json.loads(path.read_text()), user)

    def test_invalid_config_is_not_overwritten(self):
        path = self.home / 'codex' / 'hooks.json'
        path.parent.mkdir()
        path.write_text('broken')
        with self.assertRaises(ValueError):
            ai.install('codex')
        self.assertEqual(path.read_text(), 'broken')

    def test_pi_install_does_not_replace_an_unrelated_extension(self):
        path = self.home / 'pi' / 'extensions' / 'dssh-status.ts'
        path.parent.mkdir(parents=True)
        path.write_text('user extension')
        with self.assertRaises(ValueError):
            ai.install('pi', '// dssh-managed-ai-status-v1')
        self.assertEqual(path.read_text(), 'user extension')

    def test_tmux_identity_precedes_inherited_client_id_and_rejects_reused_session(self):
        row = {'id': '$1', 'created': 123, 'name': 'agent', 'pane': '%4', 'socket': '/tmp/tmux/default', 'active': True}
        with patch.dict(os.environ, {'TMUX': '/tmp/tmux/default,1,0', 'TMUX_PANE': '%4'}), patch.object(ai, 'tmux_rows', return_value=[row]):
            ai.record_event('claude', {'hook_event_name': 'Stop', 'session_id': 'one'})
            record = ai.status()[0]
            self.assertNotIn('paneId', record)
            self.assertEqual(record['tmux']['pane'], '%4')
        with patch.object(ai, 'tmux_rows', return_value=[{**row, 'created': 999}]):
            self.assertEqual(ai.status(), [])

    def test_bad_event_exits_zero_without_printing_or_making_a_decision(self):
        result = subprocess.run([sys.executable, str(SOURCE), 'event', 'codex'], input='invalid JSON',
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, '')

    def test_installed_helper_process_records_and_reads_events_in_an_isolated_home(self):
        ai.install('codex')
        env = {**os.environ, 'HOME': str(self.home), 'USERPROFILE': str(self.home)}
        for event in ('UserPromptSubmit', 'PermissionRequest', 'Stop'):
            result = subprocess.run([sys.executable, str(ai.HELPER), 'event', 'codex'],
                input=json.dumps({'hook_event_name': event, 'session_id': 'test', 'prompt': 'DO-NOT-SAVE'}),
                capture_output=True, text=True, env=env, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')
        result = subprocess.run([sys.executable, str(ai.HELPER), 'status'], capture_output=True, text=True, env=env, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]['phase'], 'idle')
        self.assertNotIn('DO-NOT-SAVE', result.stdout)


if __name__ == '__main__':
    unittest.main()
