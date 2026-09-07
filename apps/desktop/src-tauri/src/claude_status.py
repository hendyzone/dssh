"""Read existing Claude hook status without creating or modifying workspaces."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
ROOT = Path.home() / ".local" / "state" / "dssh" / "claude"

def tasks():
    if not ROOT.exists():
        return []
    live = {}
    if shutil.which('tmux'):
        result = subprocess.run(['tmux', 'list-sessions', '-F', '#{session_name}\t#{session_id}\t#{session_created}'],
                                capture_output=True, text=True, timeout=5)
        if result.returncode and not any(s in result.stderr for s in ('no server running', 'No such file or directory')):
            raise RuntimeError(result.stderr[-1000:])
        for line in result.stdout.splitlines():
            fields = line.split('\t')
            if len(fields) == 3:
                live[fields[0]] = {'name': fields[0], 'id': fields[1], 'created': int(fields[2]), 'windows': 1, 'attached': 0}
    records = []
    for path in ROOT.glob('*/task.json'):
        record = json.loads(path.read_text())
        status_file = path.parent / 'status.json'
        status = json.loads(status_file.read_text()) if status_file.exists() else {'phase': 'starting', 'updated': record['created']}
        record['status'] = status
        record['tmux'] = live.get(record['tmuxName'])
        if not record['tmux']:
            record['status'] = {**status, 'phase': 'stopped'}
        records.append(record)
    return sorted(records, key=lambda item: item['created'], reverse=True)


if __name__ == "__main__":
    try:
        print(json.dumps(tasks(), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
