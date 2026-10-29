import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultPorts = Object.freeze({workbuddy: 18690, gpt: 18691, dashboard: 18692, normalWorkbuddy: 18693});

export function dataDriveForPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) {
    throw configError('数据目录必须是本地磁盘的绝对路径，不能使用相对路径或 UNC 网络路径。');
  }
  const drive=value.slice(0,2).toUpperCase();
  if(drive==='C:')throw configError('数据目录不能位于或链接到 C 盘。');
  return drive;
}

function configError(message) {
  const error = new Error(message);
  error.code = 'LOCAL_CONFIG_INVALID';
  return error;
}

function absoluteWindowsPath(value, field, root=projectRoot) {
  if(typeof value==='string'&&/^\.[\\/]/.test(value)){
    const resolved=path.resolve(root,value),relative=path.relative(root,resolved);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw configError(`${field} 的相对路径不能离开程序目录。`);
    return resolved;
  }
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) {
    throw configError(`${field} 必须是 Windows 绝对路径，例如 E:/Apps/WorkBuddy/WorkBuddyAI.exe。`);
  }
  return path.resolve(value);
}

// Check the nearest existing ancestor too, so a junction cannot redirect writes to C:.
function physicalDestination(value) {
  let ancestor = value;
  const suffix = [];
  while (true) {
    try { fs.lstatSync(ancestor); break; }
    catch(error) { if(error.code!=='ENOENT')throw configError('数据路径无法检查：'+error.message); }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return value;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  try { return path.resolve(fs.realpathSync.native(ancestor), ...suffix); }
  catch { throw configError('数据目录无法解析，可能包含失效的目录联接或软链接。'); }
}

export function assertControlledPath(value, {dataDrive = dataDriveForPath(projectRoot), requireDataDrive = true} = {}) {
  const resolved = absoluteWindowsPath(value, '数据目录');
  if(typeof dataDrive!=='string'||!/^[A-BD-Z]:$/i.test(dataDrive))throw configError('dataDrive 必须是非 C 盘的本地盘符。');
  for (const candidate of [resolved, physicalDestination(resolved)]) {
    dataDriveForPath(candidate);
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

/** Check a Windows executable header without executing it or reading account data. */
export function validateExecutable(executable, role) {
  const names={chromeExe:['chrome.exe'],workbuddyExe:['workbuddyai.exe','workbuddy.exe']};
  if(!names[role]?.includes(path.basename(executable).toLowerCase()))throw configError(`${role} 请选实际应用程序：${names[role]?.join(' / ')}。`);
  if(!fs.existsSync(executable)||!fs.statSync(executable).isFile())throw configError(`${role} 指向的程序不存在，请填写实际安装路径。`);
  const fd=fs.openSync(executable,'r');
  try{
    const size=fs.fstatSync(fd).size,header=Buffer.alloc(64),signature=Buffer.alloc(4);
    if(size<68||fs.readSync(fd,header,0,64,0)!==64||header.toString('ascii',0,2)!=='MZ')throw configError(`${role} 不是有效的 Windows 程序，可能是测试占位文件。请重新选择已安装的软件。`);
    const offset=header.readUInt32LE(60);
    if(offset<64||offset>size-4||fs.readSync(fd,signature,0,4,offset)!==4||!signature.equals(Buffer.from([0x50,0x45,0,0])))throw configError(`${role} 的 Windows 程序头无效，请重新选择已安装的软件。`);
  }finally{fs.closeSync(fd);}
  return executable;
}

/** Verify an existing daily profile by file metadata only; never create or read account storage. */
export function validateDailyProfile(config){
  if(!config.workbuddyProfile||!config.workbuddyConfigDir)throw configError('日常模式需要填写已有 WorkBuddy 资料目录及配置子目录。');
  const directory=assertControlledPath(config.workbuddyConfigDir,{requireDataDrive:false});
  const database=assertControlledPath(path.join(directory,'workbuddy.db'),{requireDataDrive:false});
  if(!fs.existsSync(directory)||!fs.statSync(directory).isDirectory()||!fs.existsSync(database)||!fs.statSync(database).isFile())throw configError('日常 WorkBuddy 配置目录无效：'+directory+'。这里必须是已有 workbuddy.db、MCP 和 Skill 的配置目录，不能填写项目目录或新建空文件夹。请更正“日常资料目录”和“配置子目录”后保存。');
  return directory;
}

/** Read local settings without creating directories, approving access, or launching apps. */
export function loadConfig({configPath, checkExecutables = false,projectDir=projectRoot} = {}) {
  const root=path.resolve(projectDir);
  const source = path.resolve(configPath ?? process.env.WB_BRIDGE_CONFIG ?? path.join(root, 'config/local.json'));
  if (!fs.existsSync(source)) {
    const error = configError('首次使用：请在设置页自动检测软件，或点击“浏览”选择程序，再保存配置。无需手动创建配置文件。');
    error.code = 'LOCAL_CONFIG_MISSING';
    throw error;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw configError('本机配置不是有效的 JSON，请检查 config/local.json。'); }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw configError('本机配置必须为 JSON 对象。');
  const inferredDrive=dataDriveForPath(root);
  if(raw.dataDrive!==undefined&&(typeof raw.dataDrive!=='string'||!/^[A-BD-Z]:$/i.test(raw.dataDrive)))throw configError('dataDrive 必须是非 C 盘的本地盘符。');
  const dataDrive=raw.dataDrive===undefined?inferredDrive:raw.dataDrive.toUpperCase();
  if(dataDrive!==inferredDrive)throw configError('dataDrive 必须与项目所在盘符一致；默认不填写时自动使用项目所在非 C 盘。');
  assertControlledPath(root, {dataDrive});
  const workbuddyExe = absoluteWindowsPath(raw.workbuddyExe, 'workbuddyExe',root);
  const chromeExe = absoluteWindowsPath(raw.chromeExe, 'chromeExe',root);
  if (checkExecutables) {
    for (const [name, executable] of Object.entries({workbuddyExe, chromeExe})) {
      validateExecutable(executable,name);
    }
  }
  const allowNormalProfile = optionalBoolean(raw.allowNormalProfile, 'allowNormalProfile');
  const allowNativeRuntimeRecords = optionalBoolean(raw.allowNativeRuntimeRecords, 'allowNativeRuntimeRecords');
  const workbuddyMode=raw.workbuddyMode??'test';
  if(!['test','normal'].includes(workbuddyMode))throw configError('workbuddyMode 必须为 test 或 normal。');
  if(workbuddyMode==='normal'&&!allowNormalProfile)throw configError('选择日常模式需要明确允许沿用日常 WorkBuddy 配置。');
  const workbuddyProfile = raw.workbuddyProfile ? assertControlledPath(absoluteWindowsPath(raw.workbuddyProfile,'workbuddyProfile',root), {requireDataDrive: false}) : null;
  const workbuddyConfigDir = raw.workbuddyConfigDir
    ? assertControlledPath(absoluteWindowsPath(raw.workbuddyConfigDir,'workbuddyConfigDir',root), {requireDataDrive: false})
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
    if (!Object.hasOwn(defaultPorts,name) || !Number.isInteger(port) || port < 1024 || port > 65535) throw configError(`无效端口配置：${name}。`);
  }
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) throw configError('各服务端口不能相同。');
  const runtimeDir = assertControlledPath(path.join(root, 'runtime'),{dataDrive});
  const testProfile = assertControlledPath(path.join(runtimeDir, 'workbuddy-profile'),{dataDrive});
  const result = {
    configPath: source, projectRoot:root, dataDrive, workbuddyExe, chromeExe,
    workbuddyProfile, workbuddyConfigDir, workbuddyMode, allowNormalProfile, allowNativeRuntimeRecords,
    nodeExe: process.execPath, runtimeDir, testProfile,
    testConfigDir: assertControlledPath(path.join(testProfile, '.workbuddy-ai'),{dataDrive}),
    gptBrowserProfile: assertControlledPath(path.join(runtimeDir, 'gpt-browser'),{dataDrive}),
    chromeHome: assertControlledPath(path.join(runtimeDir, 'chrome-home'),{dataDrive}),
    tempDir: assertControlledPath(path.join(runtimeDir, 'temp'),{dataDrive}),
    workspace: assertControlledPath(path.join(root, 'workspaces/probe'),{dataDrive}),
    ports: Object.freeze(ports),
  };
  return Object.freeze(result);
}

export function expectedRendererPrefix(config = loadConfig()) {
  return pathToFileURL(path.join(path.dirname(config.workbuddyExe), 'resources/app.asar/renderer/index.html')).href;
}
