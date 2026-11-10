# 企微消息图谱 · DSH 插件

适用于在 macOS 上运行的 DeepSeek Harness Desktop 和本机 `dsh web`。打开左侧「企微消息图谱」后，选择企业档案即可浏览会话、联系人和消息。同步完成后，可用「导出明文数据库」把 SQLite 快照保存到本机选定的目录。

通讯录按当前企业区分内部和外部联系人。会话列表的头像右上角显示未读角标，免打扰会话显示小红点。头像使用本机缓存，群聊头像由缓存中的群成员头像组成。

可显示本机缓存中的图片、表情、视频和语音，并保存已缓存的文件。图文混排消息按原顺序显示各部分。链接、位置、卡片、合并转发和部分系统消息会显示可解析的内容。视频和文件的单次读取上限为 64 MiB，语音缓存缺失时显示文字提示。

## 构建和安装

先安装 DeepSeek Harness 桌面端，或按上游说明准备网页端的 `dsh` 命令。插件在 DSH `0.2.2-rc.1` 上验证过。 [桌面端下载](https://www.deepseek.com/harness/) · [网页端启动说明](https://github.com/deepseek-ai/deepseek-harness#run)

在 macOS 的仓库根目录执行以下命令。工具版本见 [快速开始](../../README.md#快速开始)。生成的插件包已包含 Apple 芯片和 Intel 芯片通用的读取程序与 OCR 程序。

```sh
(cd plugins/dsh && npm ci --ignore-scripts)
npm --prefix plugins/dsh run pack

plugin_version=$(node -p 'require("./plugins/dsh/package.json").version')
plugin_archive="file:$PWD/plugins/dsh/dist/dsh-wecom-local-$plugin_version.tgz"

# 按使用方式选择安装命令
dsh plugin --profile desktop add "$plugin_archive"
dsh plugin --profile web add "$plugin_archive"
```

退出并重新打开 DSH Desktop。网页端用 `dsh web --host 127.0.0.1` 启动，再使用命令输出的完整本机地址打开界面。若 `dsh` 命令未加入 PATH，可使用 DSH Desktop 设置里的命令行安装功能，或用应用包中的 `Contents/Resources/runtime/cli/bin/dsh`。

首次扫描时，macOS 可能请求允许 DeepSeek Harness 访问企业微信的数据容器。授权后点击「重新扫描」。插件的档案浏览和设置使用 DSH 的本机所有者会话。导出时使用宿主目录选择器，宿主未提供原生选择器时可输入本机保存目录。

卸载时按需执行 `dsh plugin --profile desktop remove dsh-wecom-local` 或 `dsh plugin --profile web remove dsh-wecom-local`，随后重启对应宿主。

## Agent 检索与记忆

1. 在「企微消息图谱」顶部选中企业，打开「Agent 记忆」。
2. 在「指定工作区」里加载 DSH 对话所在目录，或选择「所有 DSH 工作区」。选中要授权的群聊和私聊，确认模型访问提示，保存范围后等待索引完成。
3. 在这个工作区的 DSH 对话中，让 Agent 按项目名、人名或编号查聊天、图片文字或语音转写。展开 Agent 的企微工具卡，点「查看原消息」可回到对应气泡。
4. 要保存一条长期记忆，可请 Agent 从一条原消息提出候选。打开「Agent 记忆」，核对来源后点「确认写入」。重启后在同一工作区开新对话仍可按关键词召回。

Desktop 和本机网页端在使用同一个 DSH 数据目录时，共享索引和已确认记忆。存储路径和模型访问边界见 [数据安全说明](../../SECURITY.md)。

授权面板可以逐条勾选，也可以点「全选群聊和私聊」选中当前企业的所有会话，包括未加载的分页。核对数量后点「保存授权」，再建立或刷新索引。全选保存的是这次选中的会话，之后出现的新会话可再次全选并保存。索引按设置的时间范围读取每个会话最近最多 600 条消息。单次最多尝试识别 60 张缓存图片和 40 条缓存语音，界面会显示缓存缺失、识别失败和上限。DSH 运行期间会自动为已授权会话建索引，并在同步后更新发生变化的会话。可用「刷新索引」手动重查本地媒体缓存。图片按 OCR 文字检索，语音按分段转写检索，原文和识别文本在界面上可区分。

图片识别使用随包附带的 macOS Vision 程序。语音需要本机安装 `ffmpeg`、`whisper-cli`，并把多语言模型 `ggml-small-q5_1.bin` 放入 `~/Library/Application Support/WeComAgent/models/`。也可通过 `WECOM_FFMPEG`、`WECOM_WHISPER`、`WECOM_WHISPER_MODEL` 为 DSH 宿主设置绝对路径。语音工具未配置时，聊天和图片索引仍可使用。 [Whisper.cpp 模型说明](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)

## 会话 Copilot

配置 DSH 默认模型后，在已授权群聊或私聊的消息区底部展开「Copilot」。可以总结最近消息、整理待办，或提问「周五验收的时间定了吗？」。

Copilot 从当前会话的索引挑选片段。回答边生成边显示，可以随时停止。追问时会用同一面板里最近两条已回答的提问帮助定位话题。点击回答里的引用编号可在会话内定位原消息。问答保留在当前面板。长期记忆需要在「Agent 记忆」中单独确认。

## MessageGraph

在「Agent 记忆」中选择指定工作区或所有 DSH 工作区，保存授权会话后建立索引。用关键词或完整资料链接检索，关联卡片会显示两边的会话、原消息和依据。可组合开始日期、结束日期、会话和发送人筛选，也可以只填筛选条件。跨会话关系的两端都要符合筛选条件，并属于同一企业的已授权范围。当前支持以下关系。

- 共享链接和附件。链接按完整地址匹配，附件按消息中记录的本机缓存路径读取并比对 SHA-256。仅能按名称推测缓存位置的附件仍可按文件名检索。单次最多检查 160 个附件的缓存，计算 40 个新指纹，每个最多 16 MiB。
- 私聊提到同步资料到指定群，且 24 小时内群里出现同一资料。结果同时显示共享资料依据。
- 两边出现相同的较长正文时，结果标为「可能相关」。同会话附近的图片或语音保留为上下文。缺少原消息标识的合并转发可按摘要检索。

要扩大检索范围，在授权面板加入对应的群聊或私聊，再保存。刷新时会复用仍匹配本机媒体和识别器的 OCR 与转写结果。

DSH 的首次检索会返回关键原文、已核验的引用回复和共享资料。确认、改期和待确认的表述会标在原文旁，没有已核验的引用回复时，插件从同一会话前后 15 分钟的消息里按时间、参与人和主题找候选，标为「可能相关」。交错的不同方案各自保留原文入口。工具卡和检索面板可从返回的证据继续翻页。DSH Agent 可以调用 `messagegraph_explore`。 拿到一条来源后，`wecom_get_evidence` 会优先回查可核验的引用原文和引用回复，再找共享链接或附件。需要按顺序看聊天时，`wecom_read_timeline` 可以向前或向后分页。工具卡里的每条证据都可以打开原消息。在面板单独勾选图片访问后，支持视觉输入的模型可以按原消息引用调用 `messagegraph_read_image`。语音证据使用本机转写和时间点。DSH 对话可能保存传给模型的工具结果。

## CLI 与外部 MCP

在「Agent 记忆」的「CLI / MCP 授权」中为客户端创建独立的只读授权。选择「复制 MCP 配置」获取 JSON，或用「复制 Codex 配置」获取 TOML。执行 CLI 或启动外部 MCP 需要 Node.js 24。

使用 CLI 时，将生成配置中 `env` 的值设置到当前终端。把 `args` 中第一项替换到下列脚本路径的位置，运行 `status` 或 `explore`：

```sh
node "/path/from/config/messagegraph.mjs" status
node "/path/from/config/messagegraph.mjs" explore "上线验收" --conversation "项目群" --sender "张三"
```

时间参数 `--from` 和 `--to` 使用 Unix 秒，起点包含在内，终点不包含在内。MCP 客户端沿用面板给出的 `serve --mcp` 参数，通过 stdio 调用 `messagegraph_explore`，获取文字证据和引用。

令牌通过 `MESSAGEGRAPH_TOKEN` 环境变量提供。使用非默认 DSH 数据目录时，沿用面板生成的 `DSH_HOME`。请保管令牌，撤销客户端授权或更换该范围的会话后，旧令牌会失效。

索引和接口关系见 [代码架构](../../docs/architecture.md#messagegraph-与模型访问)。
