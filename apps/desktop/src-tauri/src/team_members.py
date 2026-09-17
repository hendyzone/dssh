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
root = pathlib.Path('.dssh/team')
path = root / (project + '.json')


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
    return result


def read():
    if not path.exists():
        return []
    assert path.stat().st_size <= 256 * 1024, '成员列表过大'
    data = json.loads(path.read_text(encoding='utf-8'))
    assert isinstance(data, list) and len(data) <= 100, '成员列表无效'
    return [member(v) for v in data]


if operation == 'members':
    print(json.dumps(read(), ensure_ascii=False))
else:
    incoming = member(json.loads(payload)) if operation == 'memberSave' else None
    assert operation in ['memberSave', 'memberRemove'], '操作无效'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Lock the read-modify-write transaction so two desktop clients cannot lose updates.
    with open(root / (project + '.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read()
        identity = (incoming['email'] or incoming['id']) if incoming else payload
        data = [m for m in data if (m['email'] or m['id']) != identity]
        if incoming:
            incoming['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            data.append(incoming)
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
