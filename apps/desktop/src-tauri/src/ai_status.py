"""Opt-in AI lifecycle bridge. No prompts, transcripts or tool arguments are persisted."""
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path.home() / '.local' / 'state' / 'dssh' / 'ai'
HELPER = Path.home() / '.local' / 'share' / 'dssh' / 'ai_status.py'
PROVIDERS = ('claude', 'codex', 'pi')
PHASES = {'SessionStart': 'ready', 'UserPromptSubmit': 'working',
          'PreToolUse': 'working', 'PostToolUse': 'working',
          'PermissionRequest': 'waiting', 'Stop': 'idle',
          'SessionEnd': 'stopped', 'Interrupt': 'idle', 'StopFailure': 'error'}


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.dssh-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def state_lock(key):
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(ROOT / (key + '.lock'), os.O_CREAT | os.O_RDWR, 0o600), 'a') as stream:
        if os.name == 'posix':
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        yield  # Event mode's alarm also bounds lock acquisition.


def phase_for(provider, payload):
    if provider not in PROVIDERS or not isinstance(payload, dict):
        return None
    # Do not let a subagent's events change the main terminal's lifecycle.
    if payload.get('agent_id') or payload.get('agent_type'):
        return None
    event = payload.get('hook_event_name')
    if provider == 'pi':
        return {'session_start': 'ready', 'agent_start': 'working', 'agent_end': 'idle',
                'ui_prompt_start': 'waiting', 'ui_prompt_end': 'working',
                'session_shutdown': 'stopped', 'error': 'error'}.get(event)
    if event == 'Notification' and provider == 'claude':
        kind = payload.get('notification_type')
        if kind in ('permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'):
            return 'waiting'
        # idle_prompt repeats Stop later and must not produce a second reminder.
        return None
    return PHASES.get(event)


def tmux_rows():
    env = dict(os.environ)
    env.pop('TMUX', None)
    result = subprocess.run(['tmux', 'list-panes', '-a', '-F',
        '#{session_id}\t#{session_created}\t#{session_name}\t#{pane_id}\t#{socket_path}\t#{window_active}\t#{pane_active}'],
        capture_output=True, text=True, timeout=1, env=env)
    if result.returncode:
        if any(s in result.stderr for s in ('no server running', 'No such file or directory')):
            return []
        raise RuntimeError('无法核验 tmux 窗格')
    rows = []
    for line in result.stdout.splitlines():
        parts = line.split('\t')
        if len(parts) == 7 and re.fullmatch(r'\$\d+', parts[0]) and re.fullmatch(r'%\d+', parts[3]):
            rows.append({'id': parts[0], 'created': int(parts[1]), 'name': parts[2],
                         'pane': parts[3], 'socket': parts[4], 'active': parts[5:] == ['1', '1']})
    return rows


def target():
    # TMUX takes precedence over an inherited DSSH_PANE_ID; panes can outlive clients.
    if os.environ.get('TMUX'):
        socket = os.environ['TMUX'].rsplit(',', 2)[0]
        for row in tmux_rows():
            if row['pane'] == os.environ.get('TMUX_PANE') and row['socket'] == socket:
                return {'tmux': {k: row[k] for k in ('id', 'created', 'name', 'pane')}}
        return None  # Custom tmux sockets are outside dssh's management scope.
    pane = os.environ.get('DSSH_PANE_ID', '')
    connection = os.environ.get('DSSH_CONNECTION_ID', '')
    if re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', pane) and re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', connection):
        return {'paneId': pane, 'connectionId': connection}
    return None


def record_event(provider, payload):
    now = time.time_ns()
    phase = phase_for(provider, payload)
    if not phase:
        return
    location = target()
    if not location:
        return
    session = payload.get('session_id')
    if not isinstance(session, str) or not session or len(session) > 256:
        return
    # One latest record per tool session and terminal target; filenames never use external paths.
    identity = json.dumps([provider, session, location.get('paneId'), location.get('connectionId'), location.get('tmux', {}).get('id'),
                           location.get('tmux', {}).get('created'), location.get('tmux', {}).get('pane')])
    key = hashlib.sha256(identity.encode()).hexdigest()
    record = {'id': key, 'provider': provider, 'phase': phase, 'updated': now // 1_000_000,
              'revision': str(now), 'observed': now // 1_000_000, **location}
    path = ROOT / (key + '.json')
    with state_lock(key):
        try:
            old = json.loads(path.read_text(encoding='utf-8'))
            if int(old.get('observedNs', old.get('revision', '0'))) > now:
                return
            if old.get('phase') == phase:
                # Keep active long-running tools discoverable without repeating a reminder.
                record['revision'] = old['revision']
                record['updated'] = old['updated']
        except (OSError, ValueError):
            pass
        record['observedNs'] = str(now)
        # Atomic replacement means readers never observe half a JSON document.
        atomic_write(path, json.dumps(record, ensure_ascii=False))


def status():
    if not ROOT.exists():
        return []
    records = []
    for path in ROOT.glob('*.json'):
        try:
            if path.stat().st_size > 8192:
                continue
            record = json.loads(path.read_text(encoding='utf-8'))
            if (isinstance(record, dict) and record.get('id') == path.stem and
                    record.get('provider') in PROVIDERS and record.get('phase') in set(PHASES.values()) and
                    isinstance(record.get('updated'), int) and
                    isinstance(record.get('observed', record['updated']), int) and
                    time.time() * 1000 - record.get('observed', record['updated']) < 86400000):
                records.append(record)
        except (OSError, ValueError):
            continue
    live = tmux_rows() if any(r.get('tmux') for r in records) else []
    latest = {}
    for record in sorted(records, key=lambda r: r.get('observed', r['updated'])):
        remote = record.get('tmux')
        if remote:
            matched = next((p for p in live if all(p[k] == remote.get(k) for k in ('id', 'created', 'pane'))), None)
            if not matched:
                continue
            record['tmux']['name'] = matched['name']
            record['active'] = matched['active']
            location = ('tmux', remote['id'], remote['created'], remote['pane'])
        else:
            location = ('pane', record.get('paneId'), record.get('connectionId'))
        latest[location] = record
    return list(latest.values())


def merged_hooks(path, provider, remove=False):
    text = path.read_text(encoding='utf-8') if path.exists() else '{}'
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get('hooks', {}), dict):
        raise ValueError(f'{path}: Hooks 配置格式无效，未修改')
    hooks = data.setdefault('hooks', {})
    command = f'{shlex.quote(sys.executable)} {shlex.quote(str(HELPER))} event {provider}'
    def owned(handler):
        if not isinstance(handler, dict) or not isinstance(handler.get('command'), str):
            return False
        try:
            args = shlex.split(handler['command'])
            return len(args) == 4 and args[1:] == [str(HELPER), 'event', provider]
        except ValueError:
            return False
    events = [key for key in PHASES if provider == 'claude' or key != 'StopFailure']
    if provider == 'claude':
        events.remove('Interrupt')
        events.append('Notification')
    for event in events:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            raise ValueError(f'{path}: {event} 格式无效，未修改')
        kept = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
                raise ValueError(f'{path}: {event} 格式无效，未修改')
            handlers = [h for h in group['hooks'] if not owned(h)]
            if handlers:
                kept.append({**group, 'hooks': handlers})
        if not remove:
            kept.append({'hooks': [{'type': 'command', 'command': command, 'timeout': 2}]})
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    return text, json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def install(provider, pi_source='', remove=False):
    if provider not in PROVIDERS:
        raise ValueError('不支持的 AI 工具')
    if provider == 'pi':
        path = Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi' / 'agent'))) / 'extensions' / 'dssh-status.ts'
        if path.exists() and not path.read_text(encoding='utf-8').startswith('// dssh-managed-ai-status-v1'):
            raise ValueError('已有同名 pi 扩展，未覆盖')
        if remove:
            path.unlink(missing_ok=True)
        else:
            source = pi_source.replace('__DSSH_HELPER__', json.dumps(str(HELPER))).replace('__DSSH_PYTHON__', json.dumps(sys.executable))
            atomic_write(HELPER, Path(__file__).read_text(encoding='utf-8'))
            atomic_write(path, source)
    else:
        directory = Path(os.environ.get('CLAUDE_CONFIG_DIR' if provider == 'claude' else 'CODEX_HOME',
                                        str(Path.home() / ('.claude' if provider == 'claude' else '.codex'))))
        path = directory / ('settings.json' if provider == 'claude' else 'hooks.json')
        old, new = merged_hooks(path, provider, remove)
        if not remove:
            atomic_write(HELPER, Path(__file__).read_text(encoding='utf-8'))
        if path.exists() and old != new:
            atomic_write(path.with_name(path.name + f'.dssh-backup-{time.time_ns()}'), old)
        if (path.read_text(encoding='utf-8') if path.exists() else '{}') != old:
            raise ValueError('配置在接入期间发生变化，请重试')
        atomic_write(path, new)
    return {'message': ('已移除接入，重启工具后生效' if remove else
            '已接入，重启工具后生效。Codex 如提示 Hooks 待审核，请在 /hooks 中审阅并信任。'), 'path': str(path)}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if mode == 'event':
        # Bound stdin as well as tmux lookup; failures never change the CLI's decision.
        if hasattr(signal, 'SIGALRM'):
            signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
            signal.alarm(1)
        try:
            raw = sys.argv[3] if len(sys.argv) > 3 else sys.stdin.read(1024 * 1024 + 1)
            if len(raw) <= 1024 * 1024:
                record_event(sys.argv[2], json.loads(raw))
            elif len(sys.argv) <= 3:
                while sys.stdin.read(65536):
                    pass
        except Exception:
            pass
        return
    if mode in ('install', 'remove'):
        import base64
        pi_source = base64.b64decode(sys.argv[3]).decode() if len(sys.argv) > 3 else ''
        print(json.dumps(install(sys.argv[2], pi_source, mode == 'remove'), ensure_ascii=False))
    else:
        print(json.dumps(status(), ensure_ascii=False))


if __name__ == '__main__':
    main()
