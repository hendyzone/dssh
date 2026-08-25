// pty <-> WebSocket 桥接服务（验证用）
// 后续可平滑替换为 ssh2 传输：字节流协议不变，仅替换 spawn 部分
import * as pty from 'node-pty';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 39871);
const wss = new WebSocketServer({ port: PORT, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[bridge] client connected');

  const shell = process.env.SHELL || '/bin/bash';
  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  term.onData((data) => {
    // 观察 Kitty graphics 序列（含 pi 的能力探测查询），便于排查
    if (data.includes('\x1b_G')) {
      const isQuery = /\x1b_G[^\\]*a=q/.test(data);
      console.log(`[kitty] pty 输出含 APC 序列 (${data.length}B)${isQuery ? ' · 包含能力探测查询 a=q' : ''}`);
    }
    ws.send(JSON.stringify({ type: 'data', data }));
  });

  term.onExit(({ exitCode }) => {
    console.log(`[bridge] shell exited (${exitCode})`);
    ws.send(JSON.stringify({ type: 'exit', exitCode }));
    ws.close();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'data') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
    } catch (err) {
      console.error('[bridge] bad message', err);
    }
  });

  ws.on('close', () => {
    console.log('[bridge] client disconnected');
    term.kill();
  });
});

console.log(`[bridge] pty-ws bridge listening on ws://0.0.0.0:${PORT}`);
