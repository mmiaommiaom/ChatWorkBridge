# 安装与使用

当前源码版本为 **0.4.0-preview.4，Windows x64 预览版**。需要已安装的 Chrome、WorkBuddy 国际版以及自己的账号。发行包内置 Node.js，不需要 npm；源码运行另见文末。请以 Release 列表实际存在的资产确认已发布版本。

## 安装或解压

从 [本仓库 Release](https://github.com/mmiaommiaom/ChatWorkBridge/releases) 选择一种：

- **setup.exe**：安装到自己选择的非 C 盘目录。
- **portable.zip**：完整解压到 D、E、F 等非 C 盘目录，不能直接在压缩包内运行。

安装器完成后可在确认提示中选择打开 START.vbs；静默安装不启动软件。ZIP 用户直接进入解压后的 ChatWorkBridge 文件夹。

默认使用程序所在盘保存受管数据。安装目录、数据库、缓存和附件不能位于 C 盘、网络共享或指向 C 盘的目录联接。安装位置应能由当前用户写入。读取位于 C 盘的 Chrome/WorkBuddy 程序不等于允许把受管数据放到 C 盘。

发行版尚未签名。如果 Windows SmartScreen 或企业策略拦截，停止运行，核对本仓库 Release 下载来源及 SHA256SUMS，或选择可审计源码。不要关闭防护、修改企业策略或绕过拦截。

## 首次使用

1. 双击 **START.vbs**，显示启动窗口并打开设置向导，默认 [127.0.0.1:18694](http://127.0.0.1:18694/)。浏览器未自动打开时，手动打开窗口显示的地址。
2. **自动检测或浏览选择**。程序检测常见安装位置、App Paths 注册表、PATH 以及程序旁的 apps 目录；未检测到时点“浏览”选择实际软件。不需要提前编辑 JSON 或创建固定路径。
3. **选择模式并保存配置**。独立测试模式自动在本项目下创建资料。日常模式会检测已有资料；未检测到时点“浏览”选原有用户资料或其配置子目录，再明确授权沿用。配置缺失会在保存时提示，不会误用空文档文件夹。确认 WorkBuddy 自身运行记录授权后保存。
4. **打开两边**。桥接会启动专用 Chrome，以及刚选择的 WorkBuddy 模式。首次使用请在需要登录的窗口自行登录，不向他人发送密码或令牌。Chrome 仍使用本项目的独立资料目录。
5. **连接会话**。在登录后进行无推理初始化：只创建或核验专用会话，不发送模型消息。连接成功不代表模型余额、剩余额度或实际执行能力已验证。
6. **打开协作台**。输入一项简单文字任务，点击开始，查看 GPT 指令与 WorkBuddy 实际回复。真正开始任务后才会发送模型消息，并可能消耗额度。

默认模式适合文字分析、规划、计算、返工及参考附件读取，不开放通用命令或任意软件操作。保持两个应用和本地服务运行。正常暂停会等待当前一次回复结束；暂停完成后可以继续。超时或结果不确定时先核验记录，不要反复点击开始。

向导默认端口为 18694；WorkBuddy 测试、GPT 浏览器、协作台、正常 WorkBuddy 分别默认为 18690、18691、18692、18693。服务仅绑定本机，不要向局域网或公网开放这些端口。

向导默认端口被占用时会自动选择其他空闲端口；实际地址保存在 data/setup-launch.json 和 logs/start.log。明确设置 WB_BRIDGE_SETUP_PORT 时尊重指定端口，冲突会提示。

“浏览”使用 Windows 自带的 Shell 选择窗口，只在点击时运行固定脚本。不调用 PowerShell，不需要修改执行策略；系统策略禁用 Windows Script Host 时仍可手动填写路径。选中路径不会自动保存授权。

## 没有打开或连接失败

运行 **START.cmd** 查看可见错误；本地日志位于安装目录的 logs 子目录。

- 找不到应用：先安装 Chrome 和 WorkBuddy 国际版，再核对路径。
- 登录未完成：回到专用窗口完成登录，然后再次检查连接。
- 端口冲突：停止自己此前启动的本项目服务，或在本机配置中更换冲突端口；不要终止不认识的进程。
- 会话初始化不确定：保留原会话 ID 与日志，核对 WorkBuddy；不会自动重新创建。
- 已有发送记录不确定：保留记录，人工核验远端是否已经执行，不用删除数据来强行重发。

受管数据保存在安装目录的 runtime、data、artifacts、logs 等目录。config/local.json 是本机配置，包含实际安装路径和授权；不要提交到 GitHub、发送给陌生人或复制其他电脑的登录资料。

升级请停止本项目任务和服务，选择新目录或空文件夹安装或解压。目录修复版允许已存在的空文件夹；目录含任何文件（包括隐藏文件）或子目录时会停止，不覆盖旧目录。本版不提供卸载器、系统注册表或桌面快捷方式安装步骤。保管旧目录的数据，尚未提供跨版本自动迁移。旧的 0.4.0-preview.1 安装包要求目标目录尚未创建，不能提前创建空文件夹。

## 高级正常模式

正常模式沿用日常 WorkBuddy 的现有 MCP、Skill、会话配置及普通权限。**首次完整正常模式接入仍待真实验收。**

1. 在已有 WorkBuddy 窗口保存工作并完全退出，包括独立测试窗口和托盘；启动器不会自动结束用户会话。
2. 在向导选择“日常 WorkBuddy”，使用检测结果或点“浏览”选择已有资料目录；也可直接选包含 workbuddy.db 的配置子目录，程序会填入对应位置。默认配置目录是资料目录内的 .workbuddy-ai。
3. 明确允许沿用日常资料和原生运行记录，保存配置；点击“打开两边应用”，按需登录，再点击“连接会话”。不要复制其他人的授权或凭据。
4. 接入核验成功后才切换运行模式，并允许打开协作台。修改程序路径、模式或权限后需要重新连接；已有未完成任务时会阻止切换。

发行版高级入口，在安装目录运行：

~~~powershell
.\runtime\node\node.exe scripts/launch-normal-workbuddy.mjs
~~~

上述命令只启动应用；登录后需要核验接入：

~~~powershell
.\runtime\node\node.exe scripts/activate-normal-workbuddy.mjs
~~~

源码用户对应使用 npm run launch:normal 或 npm run activate:normal。普通权限任务可以请求实际文件修改、命令与软件操作，但能力取决于 WorkBuddy 和其 MCP。专用测试成功不等于任意软件或用户工程已经验收。本项目没有实现 Windows 系统级沙箱，也不添加绕过 WorkBuddy 权限检查的选项。

## 模型与文件

默认只直接调用 hy3、step-5-preview、deepseek-v4.1-flash；其他模型需要使用者另外批准。价格、剩余额度与重置时间未知，免费标签不构成提供方承诺。真实额度耗尽的识别与切换尚未实际验收。

图片和文件只有在内容实际取得且检查通过后才会转发。无下载链接且没有已知本地原文件的卡片暂不能自动取回。TXT、PNG 曾实测；PDF、Word 等未逐种验证解析能力。单附件上限为 10 MiB。当前自动流程只处理 GPT 回复中实际取得的附件；协作台目标输入不支持直接上传附件，WorkBuddy 生成的文件或图片尚不能自动上传回 GPT。附件下载失败会停止任务，不能跳过文件继续派工。

## 从源码运行

使用 Windows 和 Node.js ≥22.13。将项目放在可写的非 C 盘目录，例如 D:/Apps/ChatWorkBridge 或 F:/Tools/ChatWorkBridge。当前开发电脑仍只在 E 盘执行写入与测试。

在项目目录运行：

~~~powershell
npm ci
npm start
~~~

通过设置页自动检测或浏览选择软件，保存配置并打开两边应用。首次启动可以没有 config/local.json，设置页会生成它。config/local.example.json 不再填写某台电脑的示例程序路径。

在两个专用窗口登录后，连接会话并打开协作台：

~~~powershell
node scripts/initialize-session.mjs
npm run dashboard
~~~

初始化不会发送模型消息。需要真实收发验收时，再审阅并明确运行手动脚本：

~~~powershell
node scripts/test-desktop-message.mjs --live
~~~

本项目连接已安装 Chrome，不运行 Playwright 浏览器下载器。.npmrc 将项目 npm 缓存放在 runtime/npm-cache。常用本机配置如下：

| 字段 | 含义 |
| --- | --- |
| workbuddyExe、chromeExe | 本机实际程序绝对路径，可以只读使用 C 盘程序。 |
| workbuddyMode | test 或 normal，默认 test；日常模式必须同时明确授权已有资料目录。 |
| dataDrive | 默认省略，自动使用项目所在非 C 盘；显式填写时必须与项目所在盘一致。 |
| workbuddyProfile、workbuddyConfigDir | 仅高级正常模式填写；数据不能位于或链接到 C 盘。 |
| allowNormalProfile | 默认 false；明确同意沿用日常配置后才开启。 |
| allowNativeRuntimeRecords | 默认 false；明确允许 WorkBuddy 自身必要系统运行记录后才开启。 |
| ports | 本机服务端口，不能重复或使用保留范围。 |

程序目录内的路径保存为 ./ 相对路径，移动到其他非 C 盘目录后按新位置解析；外部软件路径保持本机绝对位置。移动整个目录前应结束任务并关闭应用；移动后重新打开并连接。已完成、空闲的旧会话绑定会先保留备份，再为新位置建立专用会话；不确定或未完成任务会阻止切换，不会自动重发。

## 离线测试与手动探测

~~~powershell
npm test
~~~

默认测试仅使用合成数据及项目 runtime/test-runs 下的新目录，不登录、不调用模型、不上传附件、不操作真实软件。CI 执行依赖和语法检查及 Windows 离线测试；没有新的真实账号验收。

scripts/test-*.mjs 为独立手动探测，需要先阅读动作与前置条件，再显式加 --live。除仅启动本地 MCP 子进程的 test-mcp-boundary.mjs 外，相关探测可能发送模型消息、消耗额度、创建专用测试文件或操作测试页面。已有记录时停止核验，不删除日志绕过保护。

专用受限 MCP 需要使用者在测试 WorkBuddy 界面中自行添加、信任并连接 bridge_test，入口为 scripts/capability-mcp.mjs；使用本机 Node，策略只绑定专用测试目录和测试页。可通过 WB_BRIDGE_CAPABILITY_CONFIG 指定本机策略 JSON。程序不会自动批准 MCP，也不继承他人的信任记录。

详细验证范围见 [功能状态](STATUS.md)。维护者构建发行包见 [RELEASE](RELEASE.md)。
