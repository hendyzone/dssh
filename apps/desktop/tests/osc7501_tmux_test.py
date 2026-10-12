"""Exercise OSC 7501 on a real, isolated tmux 3.4 server (POSIX, stdlib).

Run: python3 apps/desktop/tests/osc7501_tmux_test.py
Refresh the frontend fixture with --record-fixture /path/to/fixture.json.
Uses a private temporary socket, no user config, and raw PTYs. Never attaches to
or changes an existing tmux server. This tests transport, not dssh's parser.
"""

import base64
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest

if os.name == 'posix':
    import fcntl
    import pty
    import termios
    import tty


ESC = b'\x1b'
ST = ESC + b'\\'
QUERY = ESC + b']7501;?' + ST
REPLY = ESC + b']7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth' + ST
PROMPT = ESC + b']133;A' + ST
FIXTURE_PATH = None


def report(body):
    return ESC + b']7501;' + body.encode('ascii') + ST


def passthrough(data):
    return ESC + b'Ptmux;' + data.replace(ESC, ESC + ESC) + ST


def osc_sequences(data):
    # tmux also redraws cursor/style controls around passthrough output.
    return re.findall(rb'\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)', data)


def wait_for(predicate, description, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError('Timed out waiting for ' + description)


def worker(directory):
    """Controlled program: filesystem commands out, captured PTY replies in."""
    root = Path(directory)
    tty.setraw(0)
    (root / 'ready').write_text('ready')
    index = 0
    with (root / 'input.bin').open('ab', buffering=0) as received:
        while True:
            command = root / ('command-%d.json' % index)
            if command.exists():
                payload = json.loads(command.read_text())
                if payload.get('exit'):
                    return
                os.write(1, base64.b64decode(payload['output']))
                (root / ('ack-%d' % index)).write_text('ok')
                index += 1
            ready, _, _ = select.select([0], [], [], 0.01)
            if ready:
                data = os.read(0, 65536)
                if not data:
                    return
                received.write(data)


@unittest.skipUnless(os.name == 'posix' and shutil.which('tmux'), 'requires POSIX and tmux')
class TmuxTransportTest(unittest.TestCase):
    def setUp(self):
        self.tmux_bin = getattr(self, 'tmux_bin', 'tmux')
        self.temp = tempfile.TemporaryDirectory(prefix='dssh-osc7501-')
        self.root = Path(self.temp.name)
        self.socket = str(self.root / 'server.sock')
        self.env = dict(os.environ, TERM='xterm-256color')
        self.env.pop('TMUX', None)
        self.env.pop('TMUX_PANE', None)
        self.client = None
        self.master = None
        self.addCleanup(self.cleanup)
        self.workers = {}
        self.first = self.create_worker('new-session', '-d', '-s', 'isolated')
        self.tmux('set-option', '-g', 'status', 'off')
        self.tmux('set-option', '-g', 'allow-passthrough', 'off')
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

        def controlling_tty():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        try:
            self.client = subprocess.Popen(
                [self.tmux_bin, '-S', self.socket, 'attach-session', '-t', 'isolated'],
                stdin=slave, stdout=slave, stderr=slave, env=self.env,
                preexec_fn=controlling_tty,
            )
        finally:
            os.close(slave)
        self.drain(0.5)
        self.assertIsNone(self.client.poll(), 'tmux PTY client failed to attach')

    def cleanup(self):
        # The only server ever targeted is our fresh temporary socket.
        self.tmux('kill-server', check=False)
        if self.client:
            try:
                self.client.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.client.terminate()
                self.client.wait(timeout=3)
        if self.master is not None:
            os.close(self.master)
        self.temp.cleanup()

    def tmux(self, *args, check=True):
        return subprocess.run(
            [self.tmux_bin, '-S', self.socket, '-f', '/dev/null', *args],
            env=self.env, text=True, capture_output=True, check=check, timeout=10,
        ).stdout.strip()

    def create_worker(self, command, *args):
        directory = self.root / ('worker-%d' % len(self.workers))
        directory.mkdir()
        script = shlex.join([sys.executable, str(Path(__file__).resolve()), '--worker', str(directory)])
        pane = self.tmux(command, *args, '-P', '-F', '#{pane_id}', script)
        self.workers[pane] = [directory, 0]
        wait_for(lambda: (directory / 'ready').exists(), 'worker ' + pane)
        return pane

    def send(self, pane, data=b'', exit_worker=False):
        directory, index = self.workers[pane]
        payload = dict(output=base64.b64encode(data).decode('ascii'), exit=exit_worker)
        staged = directory / 'staged.json'
        staged.write_text(json.dumps(payload))
        staged.replace(directory / ('command-%d.json' % index))
        self.workers[pane][1] += 1
        if not exit_worker:
            wait_for(lambda: (directory / ('ack-%d' % index)).exists(), 'output from ' + pane)
        return self.drain()

    def drain(self, duration=0.3):
        output = bytearray()
        end = time.monotonic() + duration
        while time.monotonic() < end:
            ready, _, _ = select.select([self.master], [], [], max(0, end - time.monotonic()))
            if not ready:
                break
            try:
                output.extend(os.read(self.master, 65536))
            except OSError:
                break
        return bytes(output)

    def input_for(self, pane):
        path = self.workers[pane][0] / 'input.bin'
        return path.read_bytes() if path.exists() else b''

    def test_reports_require_passthrough_and_lose_origin(self):
        message = report('state=working:app=cargo:progress=40')
        self.assertNotIn(message, self.send(self.first, message), 'unwrapped OSC unexpectedly forwarded')
        self.assertNotIn(message, self.send(self.first, passthrough(message)), 'off must block passthrough')
        self.tmux('set-option', '-p', '-t', self.first, 'allow-passthrough', 'on')
        captured_working = self.send(self.first, passthrough(message))
        self.assertEqual([message], osc_sequences(captured_working))
        second = self.create_worker('split-window', '-h', '-t', self.first)
        self.tmux('set-option', '-p', '-t', second, 'allow-passthrough', 'on')
        self.tmux('select-pane', '-t', self.first)
        self.drain()
        # Both visible panes deliver identical bytes; tmux adds no source id.
        self.assertEqual([message], osc_sequences(self.send(self.first, passthrough(message))))
        self.assertEqual([message], osc_sequences(self.send(second, passthrough(message))))
        hidden = self.create_worker('new-window', '-d', '-t', 'isolated')
        self.tmux('set-option', '-p', '-t', hidden, 'allow-passthrough', 'on')
        self.assertNotIn(message, self.send(hidden, passthrough(message)))
        self.tmux('set-option', '-p', '-t', hidden, 'allow-passthrough', 'all')
        self.assertEqual([message], osc_sequences(self.send(hidden, passthrough(message))))
        done = report('state=done:app=cargo')
        captured_done = self.send(self.first, passthrough(done))
        self.assertEqual([done], osc_sequences(captured_done))
        if FIXTURE_PATH:
            # Preserve actual tmux output, including its redraw controls. The
            # frontend can feed these strings through its normal stream parser.
            fixture = dict(
                tmuxVersion=subprocess.check_output(['tmux', '-V'], text=True).strip(),
                generator='apps/desktop/tests/osc7501_tmux_test.py --record-fixture',
                description='Real isolated tmux PTY output after DCS passthrough; no pane identity survives.',
                chunks=[captured_working.decode('utf-8'), captured_done.decode('utf-8')],
                expectedStates=['working', 'done'],
                expectedRecord=dict(id='', state='done', app='cargo'),
            )
            FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + '\n', encoding='utf-8')

    def test_query_replies_reach_active_pane_not_necessarily_requester(self):
        self.tmux('set-option', '-p', '-t', self.first, 'allow-passthrough', 'on')
        self.assertNotIn(QUERY, self.send(self.first, QUERY))
        self.assertEqual([QUERY], osc_sequences(self.send(self.first, passthrough(QUERY))))
        os.write(self.master, REPLY)
        wait_for(lambda: REPLY in self.input_for(self.first), 'active pane probe reply')
        second = self.create_worker('split-window', '-h', '-t', self.first)
        self.tmux('set-option', '-p', '-t', second, 'allow-passthrough', 'on')
        self.tmux('select-pane', '-t', self.first)
        self.drain()
        self.assertEqual([QUERY], osc_sequences(self.send(second, passthrough(QUERY))))
        os.write(self.master, REPLY)
        wait_for(lambda: self.input_for(self.first).count(REPLY) == 2, 'reply routed to active pane')
        self.assertNotIn(REPLY, self.input_for(second), 'inactive requester has no reply routing')

    def test_device_attributes_can_overtake_outer_probe_response(self):
        self.tmux('set-option', '-p', '-t', self.first, 'allow-passthrough', 'on')
        output = self.send(self.first, passthrough(QUERY) + ESC + b'[c')
        self.assertIn(QUERY, output)
        # tmux answers DA locally before this simulated outer terminal replies.
        self.assertRegex(self.input_for(self.first), rb'\x1b\[\?[0-9;]+c')
        self.assertNotIn(REPLY, self.input_for(self.first))
        os.write(self.master, REPLY)
        wait_for(lambda: REPLY in self.input_for(self.first), 'late feature reply')

    def test_inner_prompt_and_exit_are_not_outer_lifecycle_events(self):
        self.tmux('set-option', '-p', '-t', self.first, 'allow-passthrough', 'on')
        second = self.create_worker('split-window', '-h', '-t', self.first)
        self.drain()
        self.assertNotIn(PROMPT, self.send(self.first, PROMPT))
        self.assertEqual([PROMPT], osc_sequences(self.send(self.first, passthrough(PROMPT))))
        output = self.send(self.first, exit_worker=True)
        wait_for(lambda: self.first not in self.tmux('list-panes', '-a', '-F', '#{pane_id}').splitlines(), 'pane exit')
        self.assertIsNone(self.client.poll(), 'another pane keeps outer PTY alive')
        self.assertIn(second, self.tmux('list-panes', '-a', '-F', '#{pane_id}').splitlines())
        self.assertNotIn(PROMPT, output)
        self.assertNotIn(b']7501;', output)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(sys.argv[2])
    else:
        if '--record-fixture' in sys.argv:
            argument = sys.argv.index('--record-fixture')
            FIXTURE_PATH = Path(sys.argv[argument + 1]).resolve()
            del sys.argv[argument:argument + 2]
        if os.name == 'posix' and shutil.which('tmux'):
            print(subprocess.check_output(['tmux', '-V'], text=True).strip(), flush=True)
        unittest.main(verbosity=2)
