import { spawn } from 'node:child_process';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['electron/tests/smoke.cjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(error); process.exit(1); });
child.once('exit', code => process.exit(code ?? 1));
