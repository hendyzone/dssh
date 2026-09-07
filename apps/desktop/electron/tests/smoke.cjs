// Real Electron + real Rust + local SSH fixture, using isolated app data only.
const { app, BrowserWindow, dialog } = require('electron');
const { Server } = require('ssh2');
const { generateKeyPairSync } = require('node:crypto');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const temporary = mkdtempSync(path.join(tmpdir(), 'dssh-electron-smoke-'));
app.setPath('userData', path.join(temporary, 'chromium'));
process.env.DSSH_CONFIG_DIR = path.join(temporary, 'config');
mkdirSync(process.env.DSSH_CONFIG_DIR);
const packagedResources = process.env.DSSH_SMOKE_RESOURCES;
if (packagedResources) {
  // Exercise the assembled ASAR and packaged sidecar without touching real app data.
  const originalGetPath = app.getPath.bind(app);
  app.getPath = name => name === 'appData' ? temporary : originalGetPath(name);
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.resolve(packagedResources) });
}
const errors = [];
dialog.showErrorBox = (title, message) => errors.push(`${title}: ${message}`);
const clients = new Set();
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type:'pkcs1', format:'pem' });
const server = new Server({ hostKeys:[key] }, client => {
  clients.add(client);
  client.on('error', () => {});
  client.on('close', () => clients.delete(client));
  client.on('authentication', ctx => ctx.username === 'smoke' && ((ctx.method === 'password' && ctx.password === 'fixture-only') || ctx.method === 'publickey') ? ctx.accept() : ctx.reject());
  client.on('ready', () => client.on('session', accept => {
    const session = accept();
    session.on('pty', accept => accept?.());
    session.on('env', accept => accept?.());
    session.on('window-change', accept => accept?.());
    session.on('exec', accept => {
      const stream = accept();
      stream.write('Electron SSH 就绪\r\n');
      stream.on('data', chunk => stream.write(chunk));
    });
    session.on('sftp', accept => {
      const sftp = accept();
      sftp.on('REALPATH', (id) => sftp.name(id, [{filename:'/home/smoke',longname:'/home/smoke',attrs:{}}]));
    });
  }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i=0;i<200;i++) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
const timeout = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 45000);
(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  require(packagedResources ? path.join(process.resourcesPath, 'app.asar/electron/main.cjs') : '../main.cjs');
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
  win.webContents.on('console-message', (_event, ...args) => {
    // Electron 44 passes a details object; older versions pass positional arguments.
    const details = args[0];
    if (typeof details === 'object' ? details.level === 'error' : details >= 3) errors.push(typeof details === 'object' ? details.message : args[1]);
  });
  await until(() => !win.webContents.isLoading() && win.webContents.getURL().startsWith('dssh://'), 'renderer');
  const run = code => win.webContents.executeJavaScript(code, true);
  await until(() => run('document.querySelectorAll("button").length > 0 && !!window.dssh'), 'React and preload');
  const info = await run('({title:document.title,node:typeof require,secure:isSecureContext})');
  assert.equal(info.title,'dssh'); assert.equal(info.node,'undefined'); assert.equal(info.secure,true);
  assert.deepEqual(await run('window.dssh.invoke("servers_list", {})'), []);
  await assert.rejects(run('window.dssh.invoke("not_allowed", {})'), /Unknown command/);
  const prefs = win.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox,true); assert.equal(prefs.contextIsolation,true); assert.equal(prefs.nodeIntegration,false);
  const params = {host:'127.0.0.1',port:server.address().port,username:'smoke',authMethod:'password',secret:'fixture-only',cols:80,rows:24};
  const id = await run(`window.dssh.invoke('ssh_connect', {params:${JSON.stringify(params)}})`);
  await run(`window.smokeOutput=''; window.smokeOff=window.dssh.listen('ssh://${id}/data', text=>window.smokeOutput+=text); window.dssh.invoke('ssh_start',{sessionId:${JSON.stringify(id)}})`);
  await until(() => run('window.smokeOutput.includes("SSH 就绪")'), 'SSH output');
  await run(`window.dssh.invoke('ssh_write',{sessionId:${JSON.stringify(id)},data:'中文输入\\r'})`);
  await until(() => run('window.smokeOutput.includes("中文输入")'), 'SSH input echo');
  await run(`window.dssh.invoke('ssh_resize',{sessionId:${JSON.stringify(id)},cols:120,rows:40})`);
  assert.equal(await run(`window.dssh.invoke('sftp_home',{sessionId:${JSON.stringify(id)}})`), '/home/smoke');
  await run(`window.dssh.invoke('ssh_disconnect',{sessionId:${JSON.stringify(id)}})`);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
  await run(`window.dssh.invoke('open_image_preview',{dataUrl:${JSON.stringify(png)},width:1,height:1})`);
  const preview = BrowserWindow.getAllWindows().find(w=>w!==win);
  await until(() => preview.webContents.executeJavaScript('!!document.querySelector("img")?.complete'), 'image preview');
  await assert.rejects(preview.webContents.executeJavaScript('window.dssh.invoke("servers_list",{})'), /cannot access/);
  void preview.webContents.executeJavaScript('window.dssh.invoke("desktop_close",{})').catch(() => {});
  await until(() => preview.isDestroyed(), 'preview close');
  // Compile the exact bundled WASM under the production CSP and custom protocol.
  const dist = path.resolve(__dirname,'../../dist/assets');
  const wasm = require('node:fs').readdirSync(dist).find(name=>name.endsWith('.wasm'));
  assert.equal(await run(`fetch('dssh://app/assets/${wasm}').then(r=>r.arrayBuffer()).then(b=>WebAssembly.compile(b)).then(()=>true)`), true);
  // Render a real ghostty terminal through the application's normal connection flow.
  const keyPath = path.join(temporary, 'fixture-key'); writeFileSync(keyPath, key);
  const record = {id:'smoke-ui',name:'Electron smoke',host:'127.0.0.1',port:server.address().port,username:'smoke',authMethod:'publicKey',keyPath,hasPassword:false,hasPassphrase:false,forwards:[]};
  await run(`window.dssh.invoke('servers_upsert',{record:${JSON.stringify(record)}})`);
  win.reload();
  await until(() => !win.webContents.isLoading() && run('!!document.querySelector("[title^=\\"Electron smoke —\\"]")'), 'fixture server in sidebar');
  await run('document.querySelector("[title^=\\"Electron smoke —\\"]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
  await until(() => run('!!document.querySelector("canvas") && !!document.querySelector("[title=\\"已连接\\"]")'), 'ghostty terminal connection');
  await until(() => run('Array.from(document.querySelectorAll("canvas")).some(canvas=>canvas.width>0 && canvas.height>0)'), 'terminal canvas');
  assert.deepEqual(errors, []);
  const output = path.resolve(__dirname,'../../../../artifacts'); mkdirSync(output,{recursive:true});
  win.show(); win.focus(); await delay(300);
  writeFileSync(path.join(output,'electron-smoke.png'), (await win.webContents.capturePage()).toPNG());
  let closePrompts = 0;
  dialog.showMessageBox = async () => { closePrompts++; return {response:0}; };
  win.close();
  await until(() => closePrompts === 1, 'native close confirmation');
  assert.equal(win.isDestroyed(), false, 'canceling close must keep the active SSH window');
  console.log(JSON.stringify({passed:true,packaged:!!packagedResources,chromium:process.versions.chrome,electron:process.versions.electron,checks:['React/preload','sandbox','IPC allowlist','SSH UTF-8/resize','SFTP','preview isolation','WASM/CSP','ghostty terminal canvas','native close cancellation'],screenshot:path.join(output,'electron-smoke.png')}));
  clearTimeout(timeout);
  for (const client of clients) client.end(); server.close();
  void run('window.dssh.invoke("desktop_destroy",{})').catch(() => {});
})().catch(error => {
  console.error(error); console.error(errors); clearTimeout(timeout);
  for (const client of clients) client.end(); server.close();
  app.exit(1);
});
