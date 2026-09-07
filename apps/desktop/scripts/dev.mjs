import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const build = spawn(process.execPath, ['scripts/build-backend.mjs'], { cwd, stdio: 'inherit', windowsHide: true });
const code = await new Promise((resolve, reject) => { build.once('error', reject); build.once('exit', resolve); });
if (code !== 0) process.exit(code ?? 1);
const server = await createServer({ root: cwd, server: { host: '127.0.0.1', port: 1420, strictPort: true } });
await server.listen();
const env = { ...process.env, DSSH_DEV_URL: 'http://127.0.0.1:1420' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { cwd, env, stdio: 'inherit', windowsHide: true });
const stop = async () => { child.kill(); await server.close(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', async error => { console.error(error.message); await server.close(); process.exit(1); });
child.on('exit', async code => { await server.close(); process.exit(code ?? 0); });
