import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {loadConfig, assertControlledPath} from '../src/local-config.mjs';

const local = loadConfig({checkExecutables: true});
const {projectRoot: root, chromeExe: exe, gptBrowserProfile: profile, chromeHome: home, tempDir: temp} = local;
const port = local.ports.gpt;
for (const dir of [profile, temp, path.join(root, 'logs'), path.join(root, 'data'), home, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) {
  fs.mkdirSync(assertControlledPath(dir), {recursive: true});
}
await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});
const env = {...process.env, TEMP: temp, TMP: temp, USERPROFILE: home, HOME: home,
  HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local')};
for (const key of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|CODEBUDDY|WORKBUDDY|WB_)/i.test(key)) delete env[key];
const fd = fs.openSync(path.join(root, 'logs/gpt-browser.log'), 'a');
const child = spawn(exe, [
  '--user-data-dir=' + profile, '--disk-cache-dir=' + path.join(profile, 'Cache'), '--remote-debugging-port=' + port,
  '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
  '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', 'https://chatgpt.com/',
], {env, cwd: root, windowsHide: false, stdio: ['ignore', fd, fd]});
fs.closeSync(fd);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
const state = {startedAt: new Date().toISOString(), exe, pid: child.pid, profile, port};
const stateFile = path.join(root, 'data/gpt-browser-launch.json');
if (child.pid) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  console.log('专用 ChatGPT 浏览器已打开。首次使用请在此窗口登录。');
}
child.once('exit', (code, signal) => {
  fs.writeFileSync(stateFile, JSON.stringify({...state, exitedAt: new Date().toISOString(), code, signal}, null, 2) + '\n');
});
