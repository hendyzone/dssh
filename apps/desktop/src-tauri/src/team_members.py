"""Executed remotely via SSH; the roster contains locations, never credentials."""
import datetime
import fcntl
import json
import os
import pathlib
import re
import sys
import tempfile

project, operation, payload = sys.argv[1:]
assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', project), '项目编号无效'
if operation == 'memberBatch' and payload.startswith('@'):
    with open(payload[1:], encoding='utf-8') as source:
        payload = source.read(256 * 1024 + 1)
assert len(payload.encode('utf-8')) <= 256 * 1024, '输入过大'
root = pathlib.Path('.dssh/team')
path = root / (project + '.json')
NOTE_FIELDS = ['responsibilities', 'quota', 'currentTask', 'notes', 'aiSummary', 'aiStatus', 'aiUpdatedAt', 'aiDigest', 'aiSource', 'aiEvidence']


def annotations(v):
    result = {}
    for key in NOTE_FIELDS:
        if key in v:
            value = v[key]
            assert isinstance(value, str) and len(value) <= 2000 and not re.search(r'[\x00-\x08\x0b-\x1f\x7f]', value), '备注格式无效: ' + key
            result[key] = value
    return result


def identity(v):
    return v.get('email') or v.get('id')


def text(v, limit=1024):
    return isinstance(v, str) and bool(v.strip()) and len(v) <= limit and not re.search(r'[\x00-\x1f\x7f]', v)


def member(v):
    assert isinstance(v, dict) and v.get('project') == project, '成员项目不匹配'
    for key, limit in [('role', 80), ('host', 255), ('username', 80), ('workdir', 1024)]:
        assert text(v.get(key), limit), '成员字段无效: ' + key
    email = v.get('email')
    valid_id = isinstance(v.get('id'), str) and re.fullmatch(r'member-[a-zA-Z0-9-]{1,80}', v['id'])
    assert isinstance(email, str) and (email == '' or (text(email, 254) and re.fullmatch(r'[^\s@]+@[^\s@]+', email))), '邮箱格式无效'
    assert email or valid_id, '成员身份无效'
    assert not re.search(r'[\s/]', v['host']) and v['workdir'].startswith('/'), '成员地址无效'
    assert type(v.get('port')) is int and 1 <= v['port'] <= 65535, '端口无效'
    t = v.get('tmux')
    assert isinstance(t, dict) and re.fullmatch(r'\$\d+', t.get('id', '')), 'tmux ID 无效'
    assert type(t.get('created')) is int and 0 < t['created'] <= 9007199254740991 and text(t.get('name'), 255), 'tmux 身份无效'
    result = {key: v[key] for key in ['project', 'email', 'role', 'host', 'port', 'username', 'workdir']}
    result['tmux'] = {key: t[key] for key in ['id', 'created', 'name']}
    if valid_id:
        result['id'] = v['id']
    if text(v.get('updatedAt'), 80):
        result['updatedAt'] = v['updatedAt']
    result.update(annotations(v))
    return result


def read():
    if not path.exists():
        return []
    assert path.stat().st_size <= 256 * 1024, '成员列表过大'
    data = json.loads(path.read_text(encoding='utf-8'))
    assert isinstance(data, list) and len(data) <= 100, '成员列表无效'
    return [member(v) for v in data]


if operation == 'memberLease':
    owner = payload
    assert re.fullmatch(r'[a-zA-Z0-9-]{1,80}', owner), '采集端身份无效'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lease_path = root / (project + '.ai-lease.json')
    with open(root / (project + '.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = datetime.datetime.now(datetime.timezone.utc).timestamp()
        lease = json.loads(lease_path.read_text()) if lease_path.exists() else {}
        granted = lease.get('owner') == owner or lease.get('until', 0) <= now
        if granted:
            fd, temp = tempfile.mkstemp(dir=root, prefix='.lease-')
            try:
                with os.fdopen(fd, 'w') as output:
                    json.dump({'owner': owner, 'until': now + 180}, output)
                os.replace(temp, lease_path)
            finally:
                if os.path.exists(temp): os.unlink(temp)
        print(json.dumps({'granted': granted}))
elif operation == 'members':
    print(json.dumps(read(), ensure_ascii=False))
else:
    assert operation in ['memberSave', 'memberBatch', 'memberNotes', 'memberRemove'], '操作无效'
    incoming = []
    if operation in ['memberSave', 'memberBatch']:
        raw = json.loads(payload)
        raw = [raw] if operation == 'memberSave' else raw
        assert isinstance(raw, list) and 0 < len(raw) <= 100, '请提供 1–100 名成员'
        incoming = [member(v) for v in raw]
        assert len({identity(v) for v in incoming}) == len(incoming), '批次中成员身份重复'
    note_patch = json.loads(payload) if operation == 'memberNotes' else None
    if note_patch is not None:
        assert isinstance(note_patch, dict) and note_patch.get('project') == project and text(identity(note_patch), 254), '成员身份无效'
        annotations(note_patch)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Lock the read-modify-write transaction so two desktop clients cannot lose updates.
    with open(root / (project + '.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read()
        if operation == 'memberRemove':
            data = [m for m in data if identity(m) != payload]
        elif operation == 'memberNotes':
            target = next((m for m in data if identity(m) == identity(note_patch)), None)
            assert target is not None, '成员已移除，请刷新'
            if 'aiSource' in note_patch:
                expected = [target[k] for k in ['host', 'port', 'username', 'workdir']] + [target['tmux']['id'], target['tmux']['created']]
                assert json.loads(note_patch['aiSource']) == expected, '成员位置已变更，请重新采集'
            target.update(annotations(note_patch))
            target['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        else:
            for item in incoming:
                existing = next((m for m in data if identity(m) == identity(item)), {})
                # Omitted notes survive terminal updates; an explicit empty string clears them.
                updated = {**annotations(existing), **item}
                updated['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                data = [m for m in data if identity(m) != identity(item)]
                data.append(updated)
        assert len(data) <= 100, '最多登记 100 名成员'
        encoded = json.dumps(data, ensure_ascii=False)
        assert len(encoded.encode('utf-8')) <= 256 * 1024, '成员列表过大'
        fd, temp = tempfile.mkstemp(dir=root, prefix='.members-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                output.write(encoded)
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
        print(encoded)
