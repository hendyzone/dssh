const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const commands = new Set(require('./commands.json'));

class Backend extends EventEmitter {
  constructor(executable, configDir) {
    super();
    this.nextId = 0;
    this.pending = new Map();
    this.queues = new Map();
    this.failure = null;
    this.child = spawn(executable, [], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSSH_CONFIG_DIR: configDir },
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('后台通信格式错误')); this.child.kill(); return; }
      if (typeof message.event === 'string') { this.emit('event', message.event, message.payload); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) request.reject(new Error(String(message.error)));
      else request.resolve(message.result);
    });
    // Drain stderr without logging command arguments or credentials.
    this.child.stderr.resume();
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`SSH 后台已退出 (${code ?? signal})，请重启 dssh`)));
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.emit('failed', error);
  }
  call(command, args = {}) {
    if (!commands.has(command)) return Promise.reject(new Error(`Unknown command: ${command}`));
    // Preserve terminal input/resize/start ordering across asynchronous IPC requests.
    if (['ssh_write', 'ssh_resize', 'ssh_start', 'ssh_disconnect'].includes(command)) {
      const key = args.sessionId;
      const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.request(command, args));
      this.queues.set(key, next);
      next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
      return next;
    }
    return this.request(command, args);
  }
  request(command, args) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      let line;
      try { line = JSON.stringify({ id, command, args }) + '\n'; }
      catch (error) { reject(error); return; }
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line, error => { if (error) this.fail(error); });
    });
  }
  stop() {
    this.fail(new Error('dssh 正在退出'));
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
  }
}
module.exports = { Backend, commands };
