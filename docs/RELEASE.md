# Windows 预览发行维护说明

当前源码目标版本为 **0.4.0-preview.4**。本页面向维护者；已发布版本以 [Releases](https://github.com/mmiaommiaom/ChatWorkBridge/releases) 为准，普通用户下载安装 EXE 或 portable ZIP，按 [SETUP](SETUP.md) 启动，无需 npm。

## 构建输入

使用 Windows、PowerShell 7、本地非 C 盘源码目录，以及：

- 官方 Windows x64 Node.js ZIP 的解压根目录；当前自动构建固定为 Node.js 22.22.2。
- 含 makensis.exe 和 COPYING 的 NSIS 3.13 ZIP 解压根目录。
- 与 package.json 根版本一致的 package-lock.json。

构建脚本为 scripts/build-windows.ps1。构建输入先核对可信来源与 SHA256；自动工作流将下载地址与预期哈希固定在 [windows-release.yml](../.github/workflows/windows-release.yml) 中。脚本使用完整 NSIS 目录，不从散落的编译器文件拼装工具链。

本机项目仍只在 E 盘执行实际写入。对外构建允许 D/E/F 等非 C 盘，构建输出须留在源码所在盘，拒绝路径联接，不使用 C 盘作为输出。构建不会自动执行生成的安装器。

## 构建命令与参数

示例路径仅为占位，替换为自己的已核验工具目录：

~~~powershell
.\scripts\build-windows.ps1 -NodeDirectory "E:\BuildTools\node-v22.22.2-win-x64" -MakensisDirectory "E:\BuildTools\nsis-3.13" -Version "0.4.0-preview.4"
~~~

| 参数 | 含义 |
| --- | --- |
| -NodeDirectory | 必填，Node 官方 Windows x64 ZIP 解压根目录，包含 node.exe。 |
| -MakensisDirectory | 必填，完整 NSIS 3.13 解压目录，包含 makensis.exe、COPYING 及其附属文件。 |
| -NpmCli | 可选，npm-cli.js 路径；默认使用 NodeDirectory 内的 node_modules/npm/bin/npm-cli.js。 |
| -Version | 可选，默认 package.json 版本；必须与 package.json 和锁文件根版本完全一致。 |
| -OutputDirectory | 可选，默认 dist/<version>；指定时必须是源码所在非 C 盘的绝对路径。 |
| -Offline | 可选，使构建依赖安装使用已有 npm 离线缓存；不表示可以在缺少缓存或工具链时构建。 |

脚本按锁文件安装生产依赖，开发依赖不进入运行包；保留 Node 与依赖的许可。构建使用新的 build 子目录，不清理或覆盖现有用户数据。目标产物已存在时应改用新输出目录，而不是删除旧数据来绕过检查。

## 输出与检查

默认产物位于 dist/0.4.0-preview.4：

- ChatWorkBridge-0.4.0-preview.4-windows-x64-setup.exe
- ChatWorkBridge-0.4.0-preview.4-windows-x64-portable.zip
- SHA256SUMS
- release-manifest.json

portable ZIP 含顶层 ChatWorkBridge 目录。根目录包含 START.vbs、START.cmd、src、scripts、ui；内置 Node 位于 runtime/node/node.exe。包不包含 Chrome、WorkBuddy、模型、账号资料、原机授权、历史日志或测试结果。

安装器只向使用者选择的非 C 盘新目录或空文件夹解压；拒绝非空目录，包括仅含隐藏文件或子目录的目录。不创建卸载器、系统注册表项或桌面快捷方式。目录校验使用可见系统 PowerShell，只读检查目标与目录联接；日常模式的进程检查直接使用 tasklist.exe，无需 PowerShell。非静默安装成功后询问是否打开 START.vbs；静默安装不启动应用。升级使用新目录并保管旧目录，当前没有自动迁移保证。旧的 0.4.0-preview.1 发布安装包仍要求目录尚未创建。

发布前检查安装器和 ZIP 哈希、产物清单及许可；确认构建载荷中没有 config/local.json、账号资料、浏览器资料、数据库、附件或日志。SHA256SUMS 用于文件一致性核对，不等同于代码签名或发布者身份认证。

## 自动预发布

[Windows 发行工作流](../.github/workflows/windows-release.yml) 当前触发条件为：

- 在 GitHub Actions 手动执行 workflow_dispatch。
- main 分支提交涉及 package.json 或该工作流文件。

它下载固定版本 Node.js 22.22.2 与 NSIS 3.13，并验证硬编码 SHA256；安装锁定依赖并运行 Windows 离线测试，然后构建安装器和 ZIP，执行 packaging/test-installer.ps1 的 22 项安装路径检查。通过后以 softprops/action-gh-release@v2 创建 package.json 版本对应的预发布，上传安装器、portable ZIP、SHA256SUMS 和 release-manifest.json。

仅修改 README 或其他源码文件不会按当前路径过滤器自动触发打包。准备新版本时同步更新 package.json、锁文件和文档。工作流读取版本生成 tag/name，并在该标签已经存在时停止，避免覆盖旧发行版。

构建的 OutputDirectory 与上传 files 路径必须一致。默认本地输出有版本子目录；当前工作流显式传入 dist 根目录，和上传路径一致。修改工作流时要保留这一对应关系。

仓库是否公开由所有者另行决定。私有仓库的 Release 也受仓库访问权限限制；建立预发布并不自动把仓库或资产公开。

## 验证边界

CI 的依赖、语法、Windows 离线测试和静默安装检查不登录 ChatGPT/WorkBuddy，不发送模型消息，不运行真实任务。构建完成只证明产物生成；只有后续安装检查成功才说明对应安装路径通过。它们均不代表真实模型或日常模式完整闭环已验收。

本预览版尚未签名。遇到 SmartScreen 或企业拦截时，停止执行并核对来源、哈希与源码；不指导关闭防护或绕过企业策略。当前已知真实能力与待验收项见 [STATUS](STATUS.md)。
