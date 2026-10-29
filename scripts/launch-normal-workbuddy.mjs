import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
import {loadConfig, assertControlledPath,validateDailyProfile} from '../src/local-config.mjs';

const local = loadConfig({checkExecutables: true});
if (!local.allowNormalProfile) throw new Error('尚未允许沿用日常 WorkBuddy。请核对本机配置路径后设置 allowNormalProfile=true。');
if (!local.allowNativeRuntimeRecords) throw new Error('尚未允许 WorkBuddy 自身的原生系统运行记录。请确认后设置 allowNativeRuntimeRecords=true。');
const {projectRoot: root, workbuddyExe: exe, workbuddyProfile: profile, workbuddyConfigDir: config, tempDir: temp} = local;
const port = local.ports.normalWorkbuddy;
validateDailyProfile(local);
for (const directory of [profile, config, path.join(config, 'app'), path.join(profile, 'AppData/Roaming'), path.join(profile, 'AppData/Local'), path.join(profile, 'ProgramData')]) {
  assertControlledPath(directory, {requireDataDrive: false});
}
fs.mkdirSync(assertControlledPath(temp), {recursive: true});
// Conservatively require other instances of this app to be closed. tasklist
// reads process names only; no PowerShell or shell command text is needed.
const imageName=path.basename(exe);
const processList = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq '+imageName, '/FO', 'CSV', '/NH'], {
  encoding: 'utf8', windowsHide: false, timeout: 15000,
  env: {...process.env, TEMP: temp, TMP: temp},
});
const running=processList.split(/\r?\n/).some(line=>line.toLowerCase().startsWith('"'+imageName.toLowerCase()+'","'));
if (running) {
  console.log('请先保存工作并完全退出已有 WorkBuddy 窗口（包括独立测试窗口和托盘），再打开日常模式。现有 MCP 和 Skill 会沿用，无需重新配置。');
  process.exitCode = 2;
} else {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
  for (const directory of [path.join(root, 'logs'), path.join(root, 'data')]) fs.mkdirSync(assertControlledPath(directory), {recursive: true});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|CODEBUDDY|WORKBUDDY|WB_|ELECTRON_RUN_AS_NODE)/i.test(key)) delete env[key];
  Object.assign(env, {
    WORKBUDDY_CONFIG_DIR: config, WORKBUDDY_USER_DATA_DIR: path.join(config, 'app'), CODEBUDDY_CONFIG_DIR: config,
    WORKBUDDY_INSTALL_DIR: path.dirname(exe), WORKBUDDY_APP_NAME: 'WorkBuddy AI', WORKBUDDY_UPDATE_URL: 'https://www.workbuddy.ai',
    WORKBUDDY_REMOTE_DEBUGGING_PORT: String(port), USERPROFILE: profile, HOME: profile,
    HOMEDRIVE: path.parse(profile).root.slice(0, 2), HOMEPATH: profile.slice(2),
    APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PROGRAMDATA: path.join(profile, 'ProgramData'),
    TEMP: temp, TMP: temp, UV_CACHE_DIR: path.join(root, 'runtime/uv-cache'), PIP_CACHE_DIR: path.join(root, 'runtime/pip-cache'),
    PYTHONPYCACHEPREFIX: path.join(root, 'runtime/python-pycache'),
  });
  const fd = fs.openSync(path.join(root, 'logs/normal-workbuddy.log'), 'a');
  const child = spawn(exe, ['--user-data-dir=' + path.join(config, 'app'), '--remote-debugging-address=127.0.0.1'], {
    cwd: path.dirname(exe), env, windowsHide: false, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  const state = {startedAt: new Date().toISOString(), exe, pid: child.pid, port, profile, config, mode: 'normal', scope: 'Existing daily profile; no MCP, Skills, or credentials copied'};
  const stateFile = path.join(root, 'data/normal-launch.json');
  if (child.pid) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  child.once('exit', (code, signal) => {
    let current;try{current=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
    if(current?.pid===child.pid)fs.writeFileSync(stateFile, JSON.stringify({...state, exitedAt: new Date().toISOString(), code, signal}, null, 2) + '\n');
  });
  console.log('已按日常配置打开 WorkBuddy，正在验证连接。');
  let ready = false;
  for (let i = 0; i < 45; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1000)});
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('日常 WorkBuddy 连接接口尚未就绪，现有桥接模式没有切换。');
  console.log('日常 WorkBuddy 已启动。请完成登录后，在向导点击“连接会话”。尚未创建会话或发送任务。');
}
