import {loadConfig} from '../src/local-config.mjs';

try {
  const config = loadConfig({checkExecutables: true});
  const report = {
    ok: true,
    windows: process.platform === 'win32',
    nodeVersion: process.version,
    nodeSupported: Number(process.versions.node.split('.')[0]) > 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 13),
    dataDrive: config.dataDrive,
    workbuddyFound: true,
    chromeFound: true,
    normalProfileAuthorized: config.allowNormalProfile,
    nativeRuntimeRecordsAuthorized: config.allowNativeRuntimeRecords,
    ports: config.ports,
  };
  if (!report.windows || !report.nodeSupported) {
    report.ok = false;
    process.exitCode = 1;
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.ok ? '配置检查通过。未启动软件，也未修改本机配置。' : '需要 Windows 和 Node.js 22.13 或更新版本。');
    console.log(`日常 WorkBuddy：${config.allowNormalProfile ? '已在本机配置中允许' : '未启用'}；原生系统运行记录：${config.allowNativeRuntimeRecords ? '已在本机配置中允许' : '未授权，启动时会停止'}。`);
    console.log('费用和剩余额度不会通过此检查验证；仅保留三个指定模型的直接调用规则。');
  }
} catch (error) {
  process.exitCode = 1;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ok: false, code: error.code ?? 'CONFIG_CHECK_FAILED', error: error.message}, null, 2));
  else console.error(error.message);
}
