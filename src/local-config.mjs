import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultPorts = Object.freeze({workbuddy: 18690, gpt: 18691, dashboard: 18692, normalWorkbuddy: 18693});

function configError(message) {
  const error = new Error(message);
  error.code = 'LOCAL_CONFIG_INVALID';
  return error;
}

function absoluteWindowsPath(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) {
    throw configError(`${field} 必须是 Windows 绝对路径，例如 E:/Apps/WorkBuddy/WorkBuddyAI.exe。`);
  }
  return path.resolve(value);
}

// Check the nearest existing ancestor too, so a junction cannot redirect writes to C:.
function physicalDestination(value) {
  let ancestor = value;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return value;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync.native(ancestor), ...suffix);
}

export function assertControlledPath(value, {dataDrive = 'E:', requireDataDrive = true} = {}) {
  const resolved = absoluteWindowsPath(value, '数据目录');
  for (const candidate of [resolved, physicalDestination(resolved)]) {
    if (/^C:[\\/]/i.test(candidate)) throw configError('数据目录不能位于或链接到 C 盘。');
    if (requireDataDrive && !candidate.toUpperCase().startsWith(dataDrive.toUpperCase() + path.sep)) {
      throw configError(`桥接程序控制的数据必须保存在 ${dataDrive} 盘。`);
    }
  }
  return resolved;
}

function optionalBoolean(value, name) {
  if (value !== undefined && typeof value !== 'boolean') throw configError(`${name} 必须为 true 或 false。`);
  return value === true;
}

/** Read local settings without creating directories, approving access, or launching apps. */
export function loadConfig({configPath, checkExecutables = false} = {}) {
  const source = path.resolve(configPath ?? process.env.WB_BRIDGE_CONFIG ?? path.join(projectRoot, 'config/local.json'));
  if (!fs.existsSync(source)) {
    const error = configError('缺少本机配置。请把 config/local.example.json 复制为 config/local.json，填写 WorkBuddy 和 Chrome 路径；本机配置不会上传 GitHub。也可通过 WB_BRIDGE_CONFIG 指定配置文件。');
    error.code = 'LOCAL_CONFIG_MISSING';
    throw error;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw configError('本机配置不是有效的 JSON，请检查 config/local.json。'); }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw configError('本机配置必须为 JSON 对象。');
  if (raw.dataDrive !== undefined && String(raw.dataDrive).toUpperCase() !== 'E:') {
    throw configError('当前发行版按本项目要求只允许 dataDrive 为 E:。');
  }
  const dataDrive = 'E:';
  assertControlledPath(projectRoot, {dataDrive});
  const workbuddyExe = absoluteWindowsPath(raw.workbuddyExe, 'workbuddyExe');
  const chromeExe = absoluteWindowsPath(raw.chromeExe, 'chromeExe');
  if (checkExecutables) {
    for (const [name, executable] of Object.entries({workbuddyExe, chromeExe})) {
      if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw configError(`${name} 指向的程序不存在，请填写实际安装路径。`);
    }
  }
  const allowNormalProfile = optionalBoolean(raw.allowNormalProfile, 'allowNormalProfile');
  const allowNativeRuntimeRecords = optionalBoolean(raw.allowNativeRuntimeRecords, 'allowNativeRuntimeRecords');
  const workbuddyProfile = raw.workbuddyProfile ? assertControlledPath(raw.workbuddyProfile, {requireDataDrive: false}) : null;
  const workbuddyConfigDir = raw.workbuddyConfigDir
    ? assertControlledPath(raw.workbuddyConfigDir, {requireDataDrive: false})
    : workbuddyProfile ? path.join(workbuddyProfile, '.workbuddy-ai') : null;
  if (allowNormalProfile && (!workbuddyProfile || !workbuddyConfigDir)) {
    throw configError('启用日常 WorkBuddy 时必须填写 workbuddyProfile；config 目录默认在它的 .workbuddy-ai 子目录。');
  }
  if (workbuddyConfigDir && !workbuddyProfile) throw configError('填写 workbuddyConfigDir 时也必须填写 workbuddyProfile。');
  if (workbuddyProfile && workbuddyConfigDir) {
    const relative = path.relative(workbuddyProfile, workbuddyConfigDir);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw configError('workbuddyConfigDir 必须位于 workbuddyProfile 内。');
    }
  }
  const ports = {...defaultPorts, ...raw.ports};
  for (const [name, port] of Object.entries(ports)) {
    if (!(name in defaultPorts) || !Number.isInteger(port) || port < 1024 || port > 65535) throw configError(`无效端口配置：${name}。`);
  }
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) throw configError('各服务端口不能相同。');
  const runtimeDir = assertControlledPath(path.join(projectRoot, 'runtime'));
  const testProfile = assertControlledPath(path.join(runtimeDir, 'workbuddy-profile'));
  const result = {
    configPath: source, projectRoot, dataDrive, workbuddyExe, chromeExe,
    workbuddyProfile, workbuddyConfigDir, allowNormalProfile, allowNativeRuntimeRecords,
    nodeExe: process.execPath, runtimeDir, testProfile,
    testConfigDir: assertControlledPath(path.join(testProfile, '.workbuddy-ai')),
    gptBrowserProfile: assertControlledPath(path.join(runtimeDir, 'gpt-browser')),
    chromeHome: assertControlledPath(path.join(runtimeDir, 'chrome-home')),
    tempDir: assertControlledPath(path.join(runtimeDir, 'temp')),
    workspace: assertControlledPath(path.join(projectRoot, 'workspaces/probe')),
    ports: Object.freeze(ports),
  };
  return Object.freeze(result);
}

export function expectedRendererPrefix(config = loadConfig()) {
  return pathToFileURL(path.join(path.dirname(config.workbuddyExe), 'resources/app.asar/renderer/index.html')).href;
}
