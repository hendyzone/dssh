import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', 'backend/Cargo.toml'], {
  cwd, stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
