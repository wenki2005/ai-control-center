# AI 中枢 · 干净源码分发包

这是当前中枢的源码分发版本，需要 Node.js 24 或更新版本。它不是已安装依赖的桌面 EXE。

## 包含

- 本地网页界面、任务与审批、DSH/Codex 适配器、固定主管/派发/工作会话逻辑。
- SQLite 和记忆检索、可编辑人设卡、情绪状态、主动联系、新闻和日记的通用程序能力。
- QQ OneBot 接入与成果回传、资料导入归档的通用代码。
- 空白配置、默认中性头像、启动入口、语法检查与备份/回滚辅助脚本。

## 不包含

没有用户的人设卡/角色图片、个人记忆、聊天/任务历史、数据库、附件、日志、备份、邮箱授权、QQ 账号、API 密钥、Cookie、DSH/Codex 登录态、原机服务脚本。包内的中性占位助手可由接收者自行编辑。保留部分 mornye 技术标识以兼容原有代码，这些标识不包含角色资料。

## 首次运行

1. 解压到一个新目录，安装 Node.js 24+，在该目录运行 `npm ci --ignore-scripts --no-audit`。
2. 执行 `npm run check` 检查 JavaScript 语法。
3. 执行 `npm start`，或双击 `启动中枢.cmd`。浏览器访问 http://127.0.0.1:3188 。如果该端口已被原中枢使用，先将 `config.example.json` 的 port 改为其他端口再首次启动，或修改新目录的 `runtime/config.json`。
4. 第一次运行会从示例生成独立的 `runtime/config.json` 和空数据库。原电脑的人设、记忆、会话与配置不会迁入。

## 配置连接

DSH、Codex、QQ OneBot 服务需要自行安装并授权。本包不包含模型账户、API 服务额度、API 密钥或授权。程序中的 HTTP/API 路由和适配器代码保留。

- DSH：在新 `runtime/config.json` 设置 `dshPrimaryUrl`，默认 3080。若新版 DSH 要求启动凭据，可在启动终端设置 `DSH_LAUNCH_TOKEN` 环境变量；或通过 `DSH_LOG_PATH` 指向本人 DSH 启动日志，移除示例中的 `dshPrimaryUrl` 后自动发现。不会预填任何真实 token。可选 `DSH_CONTROLLER_PATH` 指向控制器源码以校验请求去重能力，`DSH_INSTALL` 用于可选插件源码。仅配置本人可信的本地 DSH。
- Codex：自行安装并登录 Codex CLI，将 `codexCommand` 配置为完整可执行路径。默认命令为 `codex`，执行依赖 PATH；健康面板的可执行文件检查建议用绝对路径。不同版本需要独立验收。
- QQ：复制 `qq-config.example.json` 到新 `runtime/qq-config.json`，填入本人 owner 和 OneBot 凭据，再把新 `runtime/config.json` 中 `qqIngressEnabled` 改为 true，重启本包。首次接入使用命令前缀模式；不要和另一套接管相同账号的中枢同时启用。没有配置时 QQ 默认关闭。
- 邮箱：在所选引擎中另行安装邮件技能并完成授权，本包不携带既有邮箱账户。
- 文档/图片解析：按需要安装 Python 和 `pypdf python-docx openpyxl python-pptx Pillow PyMuPDF`；基本纯文本归档无需这些额外包。
- 可选联网 CLI：自行安装 `bili`、`mcporter`、`opencli`，分别可用 `HUB_BILI_COMMAND`、`HUB_MCPORTER_CLI`、`HUB_OPENCLI_COMMAND` 覆盖路径；相关账户与 MCP 配置由使用者提供。

## 使用与范围

打开人设卡自行新建或编辑，再配置自己的长期记忆。主动联系、新闻和日记可在界面设置；真实执行与推送需要模型及 QQ 连接正常。

这个包是从当前工作区生成的独立清洁副本，通用化修改仅在副本进行，不会重载原服务。旧版自启/守护、桌面 Electron 包、原机 DSH 维护和自动修复部署流程不随包分发；专职维护默认关闭，primaryMode 请保持 false。`src/director-plugin` 保留工具逻辑和研究读取模块，但不含绑定旧人设的插件安装清单，不是可直接安装的 DSH 插件包。

分发包不附带原工作区的个人验收记录和测试集，`npm run check` 只检查语法。打包方另外完成了独立空数据启动检查；接收方仍需对自己的 DSH/Codex/QQ 账户做真实链路验收。依赖 ws 通过 npm 安装，适用其自身许可；DSH、Codex 和其他外部组件未打包。项目自身的再发布许可由项目所有者决定。

后续转发时，勿将自己运行后生成的 runtime、.env、node_modules、日志或备份加入压缩包。
