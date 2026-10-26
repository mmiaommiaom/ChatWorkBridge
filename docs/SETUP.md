# 本机安装与运行

需要 Windows、Node.js 22.13 或更新版本、Chrome、WorkBuddy 国际版，以及使用者自己的账号。当前实现要求项目与受管数据放在 E 盘；例如将仓库克隆到 `E:/Apps/ChatWorkBridge`。

## 1. 安装依赖

在项目目录运行：

```powershell
npm ci
Copy-Item config/local.example.json config/local.json
```

仓库只声明 npm 依赖，不附带应用、浏览器、模型或第三方源码。没有锁文件或主动变更依赖时才使用 `npm install`；通常按提交的锁文件使用 `npm ci`。项目 `.npmrc` 将 npm 缓存保存在本目录 `runtime/npm-cache`。不要运行 Playwright 浏览器安装器，本项目连接已安装的 Chrome。

## 2. 填写本机配置

编辑 `config/local.json`：

| 项目 | 填写内容 |
| --- | --- |
| `workbuddyExe` | 自己安装的 WorkBuddy 程序，例如 `E:/Apps/WorkBuddy/WorkBuddyAI.exe`。 |
| `chromeExe` | 自己安装的 Chrome 程序，例如 `E:/Apps/Chrome/Application/chrome.exe`。 |
| `workbuddyProfile` | 要沿用的日常 WorkBuddy 资料目录。仅在使用正常模式时填写。 |
| `workbuddyConfigDir` | 对应资料中的 WorkBuddy 配置目录。请确认其中确实是要使用的 MCP、Skill 和账号配置。 |
| `allowNormalProfile` | 默认 `false`。决定沿用上述日常配置并接受其现有权限时，才由使用者自行改为 `true`。 |
| `allowNativeRuntimeRecords` | 默认 `false`。确认允许 WorkBuddy 自身必需的系统运行记录后，才由使用者自行改为 `true`；启动器不会继承原开发机器的授权。 |
| `ports` | 本地连接端口；与本机其他服务冲突时自行选择空闲端口。 |

JSON 路径建议使用 `/`，避免反斜杠转义错误。`local.json`、浏览器资料、账号配置、任务数据库和运行日志均为本地数据，不应上传。不要把其他电脑的登录目录复制过来。

检查填写结果：

```powershell
npm run config:check
npm run preflight
```

检查不会验证模型余额或剩余额度，也不代表正常模式已经接入成功。

## 3. 打开应用并登录

```powershell
npm run open-apps
```

在新开的专用 Chrome 和 WorkBuddy 窗口中自行登录，保持窗口运行。桥接连接本机受管实例；不要把调试端口开放给局域网或公网。

全新克隆没有历史任务绑定。首次使用测试模式，请在登录后先检查桌面连接，再明确执行一次收发探测来创建专用绑定：

```powershell
node scripts/probe-desktop.mjs
node scripts/test-desktop-message.mjs --live
```

第一项只读检查；第二项会真实调用白名单中的 DeepSeek，发送一条随机字符串测试消息并记录绑定。它可能消耗模型额度。首次探测成功后才进入协作台开始任务；已有绑定时不要重复执行。

测试模式使用独立 WorkBuddy 资料，不含日常 MCP 和 Skill。要沿用日常配置，请先保存工作并完全退出日常 WorkBuddy，再确认本机配置中的两个授权项，然后运行：

```powershell
npm run launch:normal
```

启动器不会终止已有日常实例。接入与模型目录检查成功后才会切换；需要重新验证已有正常实例的接入时可运行 `npm run activate:normal`。**首次完整正常模式接入仍待验收**，启动成功和整个任务闭环成功应分别核对。

正常模式沿用 WorkBuddy 的现有普通权限、MCP 与 Skill。不通过复制凭据或添加绕过权限选项接入。系统级隔离未实现，第三方 MCP 的能力与权限由自身配置决定。

## 4. 开始任务

```powershell
npm run dashboard
```

打开终端显示的本地地址，在协作台输入任务并开始。保持启动窗口和两个应用运行。可选择当前回复结束后暂停，再继续正常暂停的任务。

新任务复用 GPT 受管标签页；同一任务各轮保留在同一聊天。有草稿、生成尚未结束、页面被手动切换或远端执行结果不确定时会停下，先核对界面与日志，不要反复点击开始重发。

默认仅直接调用 `hy3`、`step-5-preview`、`deepseek-v4.1-flash`。其他模型需要另外批准。免费标签是使用者设置的策略；余额与重置时间未知，真实额度耗尽的识别尚未完成实际验收。

## 5. 本地测试与手动能力探测

```powershell
npm test
```

默认测试使用合成数据与本次新建的 E 盘临时目录，不登录、不调用模型、不上传附件、不操作真实软件。`npm run test:unit` 是同类本地测试入口。测试产物留在 `runtime/test-runs`，不随仓库发布。

`scripts/test-*.mjs` 是另行手动执行的探测脚本，默认不运行。先阅读脚本，并确认允许其描述的动作，再显式加 `--live`。它们可能向模型发送消息、产生额度消耗、创建专用文件或操作测试页面，不能当成本地单元测试执行。

| 探测 | 前置条件与动作 |
| --- | --- |
| `test-desktop-message.mjs` | 已登录的测试 WorkBuddy；新建专用会话并发送一次随机字符串收发测试。已有绑定时会停止。 |
| `test-desktop-followup.mjs` | 本机刚完成上一项，使用该项生成的绑定；继续同一专用会话验证回忆。 |
| `test-native-file.mjs` | 已登录的测试 WorkBuddy；创建本次专用测试文件。 |
| `test-native-edit-command.mjs` | 本机刚完成文件探测；HY3 修改测试文件，Step 尝试运行当前 Node 的 `--version`。 |
| `test-native-attachments.mjs` | 已登录的测试 Chrome 与 WorkBuddy；生成新 TXT、PNG 并交给模型读取。 |
| `test-gpt-attachment-source.mjs` | 本机刚完成附件探测，并有受管空白 GPT 页面；上传本次生成的 TXT、PNG 并发消息。 |
| `test-dashboard-recovery.mjs` | 本地协作台已在受管 Chrome 打开；实际提交一项任务，验证暂停和继续。 |
| `test-controlled-tools.mjs` | 开发者已配置专用受限 MCP 与本机能力策略；模型读写固定测试文件、查询 Node 版本并操作指定测试页。 |
| `test-mcp-boundary.mjs` | 只启动本仓库本地 MCP 子进程，验证路径和命令拒绝，不调用模型。 |

受限 MCP 联调还需要在测试 WorkBuddy 的界面中自行添加、信任并连接名为 `bridge_test` 的服务器，程序入口是本仓库的 `scripts/capability-mcp.mjs`，命令使用本机 Node。策略文件只应绑定专用测试目录和测试页；可通过 `WB_BRIDGE_CAPABILITY_CONFIG` 指向本机策略 JSON。脚本不会调用自动批准或自动连接接口，也不继承其他电脑的 MCP 信任记录。

手动例子：

```powershell
node scripts/test-desktop-message.mjs --live
```

这些探测只使用当前电脑产生的新记录，不需要开发者历史数据。检测到已有发送或探测记录时会停止，避免重复执行；请先核对记录，不要以删除日志的方式绕过保护。

附件自动传递只处理实际取得的内容。无链接且无已知本地原文件的卡片不能自动下载；PDF、Word 等仍需分别验收。更多实测边界见 [STATUS.md](STATUS.md)。
