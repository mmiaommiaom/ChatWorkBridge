import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {loadConfig, assertControlledPath} from '../src/local-config.mjs';

const local = loadConfig({checkExecutables: true});
if (!local.allowNativeRuntimeRecords) throw new Error('请先确认 WorkBuddy 自身可能产生的原生系统运行记录，再在本机配置中设置 allowNativeRuntimeRecords=true。');
const {projectRoot: root, workbuddyExe: exe, testProfile: profile, testConfigDir: config, tempDir: temp, workspace} = local;
for (const dir of [profile, config, temp, workspace, path.join(root, 'logs'), path.join(root, 'data'), path.join(profile, 'AppData/Roaming'), path.join(profile, 'AppData/Local'), path.join(profile, 'ProgramData')]) {
  fs.mkdirSync(assertControlledPath(dir), {recursive: true});
}
const settings = path.join(config, 'settings.json');
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({autoLaunchDefaultApplied: true, startupForceAutoUpdate: false}, null, 2) + '\n');
const port = local.ports.workbuddy;
await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|CODEBUDDY|WORKBUDDY|WB_|ELECTRON_RUN_AS_NODE)/i.test(key)) delete env[key];
Object.assign(env, {
  WORKBUDDY_CONFIG_DIR: config, WORKBUDDY_USER_DATA_DIR: path.join(config, 'app'), WORKBUDDY_INSTALL_DIR: path.dirname(exe),
  WORKBUDDY_APP_NAME: 'WorkBuddy AI', WORKBUDDY_UPDATE_URL: 'https://www.workbuddy.ai', CODEBUDDY_CONFIG_DIR: config,
  WORKBUDDY_REMOTE_DEBUGGING_PORT: String(port), USERPROFILE: profile, HOME: profile,
  HOMEDRIVE: path.parse(profile).root.slice(0, 2), HOMEPATH: profile.slice(2),
  APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
  PROGRAMDATA: path.join(profile, 'ProgramData'), TEMP: temp, TMP: temp,
});
const logfile = path.join(root, 'logs/native-workbuddy.log');
const fd = fs.openSync(logfile, 'a');
const child = spawn(exe, ['--user-data-dir=' + path.join(config, 'app'), '--remote-debugging-address=127.0.0.1'], {
  cwd: path.dirname(exe), env, windowsHide: false, stdio: ['ignore', fd, fd],
});
fs.closeSync(fd);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
const state = {startedAt: new Date().toISOString(), exe, pid: child.pid, port, profile, workspace, logfile, scope: 'Dedicated test profile; no daily profile or credential copying'};
const stateFile = path.join(root, 'data/native-launch.json');
if (child.pid) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  console.log('测试 WorkBuddy 已打开。请在它自己的窗口中登录。');
}
child.once('exit', (code, signal) => {
  fs.writeFileSync(stateFile, JSON.stringify({...state, exitedAt: new Date().toISOString(), code, signal}, null, 2) + '\n');
});
