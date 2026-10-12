"""Validate dssh's production collector against an isolated patched tmux.

TMUX_BIN=/path/to/tmux-ps python3 apps/desktop/tests/osc7501_pane_ps_test.py
Optional: REFERENCE_TMUX=/usr/bin/tmux (unpatched baseline).
Only temporary -S sockets are created; no user server/config is changed.
"""

import base64
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
import unittest

import osc7501_tmux_test as transport


PATCHED_TMUX = os.environ.get('TMUX_BIN', '')
REFERENCE_TMUX = os.environ.get('REFERENCE_TMUX', shutil.which('tmux') or '')
SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri' / 'src'
FIELDS = ('session_id', 'session_created', 'session_name', 'pane_id', 'window_id',
          'window_active', 'pane_active', 'state', 'kind', 'progress', 'app', 'title', 'msg')


def collector_script():
    source = (SOURCE / 'tmux_program_status.rs').read_text(encoding='utf-8')
    match = re.search(r'const PRODUCTION_COMMAND: &str = r#"(.*?)"#;', source, re.S)
    if not match:
        raise AssertionError('Cannot locate production collection script')
    return match.group(1)


def decode_snapshot(payload):
    if payload == b'DSSH_TMUX_PS_UNSUPPORTED\n':
        return None
    header = b'DSSH_TMUX_PS_V1\n'
    if not payload.startswith(header):
        raise AssertionError('Invalid production snapshot header: %r' % payload[:100])
    payload = payload[len(header):]
    rows = []
    while payload:
        row = {}
        for index, name in enumerate(FIELDS):
            size, separator, payload = payload.partition(b':')
            if not separator or not size.isdigit():
                raise AssertionError('Invalid netstring length')
            length = int(size)
            value, payload = payload[:length], payload[length:]
            delimiter = b'\n' if index == len(FIELDS) - 1 else b','
            if not payload.startswith(delimiter):
                raise AssertionError('Byte length/framing mismatch for %s: %r' % (name, value))
            payload = payload[1:]
            row[name] = value.decode('utf-8')
        rows.append(row)
    return rows


def navigation_command(session_id, created, pane):
    """Execute production guard literals, not copies of their shell logic."""
    source = (SOURCE / 'tmux.rs').read_text(encoding='utf-8')
    # Only decode the three single-line Rust literals under test; the module
    # also contains multiline raw strings, which are not JSON strings.
    candidates = re.findall(r'"((?:[^"\\]|\\.)*)"', source)
    candidates = [value for value in candidates if value.startswith(('[ \\"$(tmux display-message', 'tmux list-panes -s -t {sid}', 'window=$(tmux display-message -p -t {target}'))]
    literals = [json.loads('"' + value + '"') for value in candidates]
    identity = next(value for value in literals if value.startswith('[ "$(tmux display-message'))
    membership = next(value for value in literals if value.startswith('tmux list-panes -s -t {sid}'))
    select = next(value for value in literals if value.startswith('window=$(tmux display-message -p -t {target}'))
    quote = lambda value: "'" + str(value).replace("'", "'\"'\"'") + "'"
    identity = identity.replace('{}', quote(session_id), 1).replace('{}', quote(created), 1)
    membership = membership.replace('{sid}', quote(session_id)).replace('{}', quote(pane), 1)
    select = select.replace('{target}', quote(pane)).replace('{}', quote(session_id + ':'), 1)
    identity = identity.replace('{{', '{').replace('}}', '}')
    membership = membership.replace('{{', '{').replace('}}', '}')
    select = select.replace('{{', '{').replace('}}', '}')
    return 'unset TMUX; ' + identity + membership + select + ' tmux select-pane -t ' + quote(pane)


@unittest.skipUnless(os.name == 'posix' and PATCHED_TMUX, 'set TMUX_BIN to an isolated patched tmux binary')
class PatchedPaneStatusTest(unittest.TestCase):
    def setUp(self):
        self.terminal = transport.TmuxTransportTest(methodName='runTest')
        self.terminal.tmux_bin = PATCHED_TMUX
        self.terminal.setUp()
        self.addCleanup(self.terminal.doCleanups)
        self.root = self.terminal.root
        self.first = self.terminal.first
        self.session = self.tmux('display-message', '-p', '-t', self.first, '#{session_id}')
        self.created = int(self.tmux('display-message', '-p', '-t', self.first, '#{session_created}'))
        self.environment = self.wrapper(PATCHED_TMUX, self.terminal.socket, 'patched')
        self.assertEqual(self.tmux('show-hooks', '-g', 'pane-status-changed'), 'pane-status-changed')

    def tmux(self, *args, **kwargs):
        return self.terminal.tmux(*args, **kwargs)

    def wrapper(self, binary, socket, name):
        directory = self.root / name
        directory.mkdir()
        executable = directory / 'tmux'
        executable.write_text('#!/bin/sh\nexec %s -S %s "$@"\n' % (shlex.quote(binary), shlex.quote(socket)))
        executable.chmod(0o700)
        return dict(self.terminal.env, PATH=str(directory) + os.pathsep + os.environ.get('PATH', ''))

    def collect(self, environment=None, raw=False):
        result = subprocess.run(['sh', '-c', collector_script()], env=environment or self.environment,
                                capture_output=True, timeout=10, check=True)
        return result.stdout if raw else decode_snapshot(result.stdout)

    def row(self, pane):
        return next(row for row in self.collect() if row['pane_id'] == pane)

    def send(self, pane, body):
        return self.terminal.send(pane, transport.report(body))

    def navigate(self, session_id, created, pane):
        return subprocess.run(['sh', '-c', navigation_command(session_id, created, pane)],
                              env=self.environment, text=True, capture_output=True, timeout=10)

    def test_hidden_pane_and_untrusted_text_roundtrip_without_execution(self):
        hidden = self.terminal.create_worker('new-window', '-d', '-t', self.session)
        marker = self.root / 'must-not-execute'
        msg = "中文 |DSSH-TMUX|,9:abc '#{pane_id}' #[fg=red] $(touch %s) `touch %s` #(touch %s) \\" % (marker, marker, marker)
        title = '标题,7:$(false) #[fg=red] #{pane_id}'
        # tmux 3.7c itself rejects C0 bytes in session names. Keep a regression
        # assertion for that boundary, then exercise real UTF-8 byte lengths.
        with self.assertRaises(subprocess.CalledProcessError):
            self.tmux('rename-session', '-t', self.session, '中文\n队列\t')
        session_name = "中文 队列,9-abc |DSSH-TMUX| ' #[(not-style)]"
        self.tmux('rename-session', '-t', self.session, session_name)
        encode = lambda text: base64.b64encode(text.encode('utf-8')).decode('ascii')
        output = self.send(hidden, 'state=blocked:kind=permission:progress=42:app=claude-code:msg=%s:title=%s' % (encode(msg), encode(title)))
        self.assertNotIn(b']7501;', output, 'native pane status is consumed by tmux, not forwarded')
        row = self.row(hidden)
        self.assertEqual(row['state'], 'blocked')
        self.assertEqual(row['kind'], 'permission')
        self.assertEqual(row['progress'], '42')
        self.assertEqual(row['app'], 'claude-code')
        self.assertEqual(row['msg'], msg)
        self.assertEqual(row['title'], title)
        self.assertEqual(row['session_name'], session_name)
        self.assertEqual(row['window_active'], '0')
        self.assertFalse(marker.exists(), 'program text must never become a shell/format command')
        self.assertEqual(self.row(self.first)['state'], '')
        fixture = os.environ.get('PANE_PS_FIXTURE')
        if fixture:
            Path(fixture).write_text(json.dumps(dict(
                tmuxVersion=subprocess.check_output([PATCHED_TMUX, '-V'], text=True).strip(),
                generator='osc7501_pane_ps_test.py (exact PRODUCTION_COMMAND)',
                raw=self.collect(raw=True).decode('utf-8'), expected=row,
            ), ensure_ascii=True, indent=2) + '\n', encoding='utf-8')

    def test_native_probe_replies_to_hidden_requester_before_device_attributes(self):
        hidden = self.terminal.create_worker('new-window', '-d', '-t', self.session)
        self.terminal.send(hidden, transport.QUERY + b'\x1b[c')
        transport.wait_for(lambda: self.terminal.input_for(hidden).endswith(b'c'), 'hidden pane probe')
        received = self.terminal.input_for(hidden)
        self.assertTrue(received.startswith(transport.QUERY), repr(received))
        self.assertRegex(received[len(transport.QUERY):], rb'^\x1b\[\?[0-9;]+c$')
        self.assertNotIn(transport.QUERY, self.terminal.input_for(self.first))

    def test_native_clear_prompt_and_exit_stay_scoped_to_source_pane(self):
        hidden = self.terminal.create_worker('new-window', '-d', '-t', self.session)
        self.send(self.first, 'state=working:app=build')
        self.send(hidden, 'state=blocked:app=deploy:kind=auth')
        self.terminal.send(self.first, transport.PROMPT)
        self.assertEqual(self.row(self.first)['state'], '')
        self.assertEqual(self.row(hidden)['state'], 'blocked')
        self.send(self.first, 'state=done:app=build')
        self.terminal.send(self.first, transport.PROMPT)
        self.assertEqual(self.row(self.first)['state'], 'done')
        self.send(hidden, 'state=clear')
        self.assertEqual(self.row(hidden)['state'], '')
        self.assertEqual(self.row(self.first)['state'], 'done')
        self.tmux('set-option', '-g', 'remain-on-exit', 'on')
        self.send(hidden, 'state=working:app=deploy')
        self.terminal.send(hidden, exit_worker=True)
        transport.wait_for(lambda: self.tmux('display-message', '-p', '-t', hidden, '#{pane_dead}') == '1', 'hidden pane exit')
        self.assertEqual(self.row(hidden)['state'], '')
        self.terminal.send(self.first, exit_worker=True)
        transport.wait_for(lambda: self.tmux('display-message', '-p', '-t', self.first, '#{pane_dead}') == '1', 'done pane exit')
        self.assertEqual(self.row(self.first)['state'], 'done')

    def test_patch_only_retains_root_record(self):
        self.send(self.first, 'state=working:app=root')
        self.send(self.first, 'state=blocked:id=child:app=child:kind=question')
        self.assertEqual(self.row(self.first)['state'], 'working')
        self.assertEqual(self.row(self.first)['app'], 'root')
        self.send(self.first, 'state=clear:id=child')
        self.assertEqual(self.row(self.first)['state'], 'working')

    def test_production_navigation_rejects_wrong_session_and_selects_hidden_pane(self):
        hidden = self.terminal.create_worker('new-window', '-d', '-t', self.session)
        outside = self.terminal.create_worker('new-session', '-d', '-s', 'outside')
        rejected = self.navigate(self.session, self.created, outside)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(self.row(self.first)['window_active'], '1')
        rejected = self.navigate(self.session, self.created + 1, hidden)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(self.row(hidden)['window_active'], '0')
        accepted = self.navigate(self.session, self.created, hidden)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(self.row(hidden)['window_active'], '1')
        self.assertEqual(self.row(hidden)['pane_active'], '1')

    def test_session_id_reuse_cannot_navigate_using_old_creation_time(self):
        self.tmux('kill-server')
        self.terminal.client.wait(timeout=3)
        time.sleep(1.05)  # tmux incarnation timestamps have one-second precision.
        self.tmux('new-session', '-d', '-s', 'replacement', 'sleep 30')
        reused = self.tmux('display-message', '-p', '-t', 'replacement', '#{session_id}')
        pane = self.tmux('display-message', '-p', '-t', 'replacement', '#{pane_id}')
        self.assertEqual(reused, self.session)
        self.assertNotEqual(int(self.tmux('display-message', '-p', '-t', reused, '#{session_created}')), self.created)
        self.assertNotEqual(self.navigate(reused, self.created, pane).returncode, 0)

    def test_production_navigation_reveals_target_when_other_pane_is_zoomed(self):
        second = self.terminal.create_worker('split-window', '-d', '-t', self.first)
        self.tmux('resize-pane', '-Z', '-t', self.first)
        self.assertEqual(self.tmux('display-message', '-p', '-t', self.first, '#{window_zoomed_flag}'), '1')
        accepted = self.navigate(self.session, self.created, second)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(self.row(second)['pane_active'], '1')
        self.assertEqual(self.tmux('display-message', '-p', '-t', second, '#{window_zoomed_flag}'), '0')

    def test_unpatched_or_missing_server_is_unsupported_without_starting_one(self):
        missing = str(self.root / 'missing.sock')
        self.assertIsNone(self.collect(self.wrapper(PATCHED_TMUX, missing, 'missing')))
        self.assertFalse(Path(missing).exists())
        if not REFERENCE_TMUX:
            self.skipTest('unpatched reference binary unavailable')
        socket = str(self.root / 'reference.sock')
        command = [REFERENCE_TMUX, '-S', socket, '-f', '/dev/null']
        subprocess.run(command + ['new-session', '-d', '-s', 'reference', 'sleep 30'], env=self.terminal.env, check=True, timeout=10)
        self.addCleanup(lambda: subprocess.run(command + ['kill-server'], env=self.terminal.env, capture_output=True, timeout=10))
        self.assertIsNone(self.collect(self.wrapper(REFERENCE_TMUX, socket, 'reference')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
