# 企微消息图谱 · WeCom MessageGraph

在 Mac 上浏览已授权的企业微信本地档案，按企业查看群聊、私聊、联系人和历史消息。安装 DeepSeek Harness 插件后，还可以用 MessageGraph 查找跨会话证据，让 Agent 回答时引用原消息。

| 使用方式 | 能做什么 |
| --- | --- |
| [原生 macOS App](apps/macos/README.md) | 浏览会话和通讯录，按群聊、私聊、内外部和已读状态筛选，查看本机媒体缓存，导出 SQLite 快照 |
| [企微消息图谱（DSH 插件）](plugins/dsh/README.md) | 在 DSH Desktop 和本机网页端浏览档案与缓存媒体，用 Copilot 总结、整理待办和追问，通过 MessageGraph 检索、回查和确认长期记忆 |
| [MessageGraph CLI / MCP](plugins/dsh/README.md#cli-与外部-mcp) | 使用 DSH 签发的独立只读授权，从终端或其他 MCP 客户端查询同一份索引 |

## 快速开始

使用 macOS 13 或以上版本。两种构建都需要 Bun 和带 Swift 工具链的 Xcode 15 或以上版本。插件开发和 CLI 需要 Node.js 24，构建插件还需要 npm。

**直接浏览档案**

在仓库根目录构建并打开原生 App：

```sh
bun apps/macos/build.ts
open "apps/macos/dist/WeCom Local.app"
```

打开后从顶部选择企业。若 macOS 请求访问企业微信数据容器，按提示授权后重新扫描。本地构建的 App 使用本地签名，未做发行签名或公证。

**在 DSH 中检索或提问**

打包并安装插件。从左侧打开「企微消息图谱」，选中企业后进入「Agent 记忆」，保存要授权的会话，等待索引完成。 [插件安装说明](plugins/dsh/README.md#构建和安装)

例如，在某个项目群底部打开 Copilot，问「周五验收的时间定了吗？」回答会边生成边显示，点击引用编号即可定位原消息。需要同时查群聊和私聊时，使用「Agent 记忆」里的 MessageGraph，或从获授权的 DSH Agent 会话调用。

## 索引和数据

- MessageGraph 在 DSH 运行期间增量更新已授权的会话。支持聊天正文、缓存图片的 OCR 和缓存语音的本机转写。视频可预览本机缓存，当前不进入检索索引。
- 有引用、回复或共享资料时，可以沿证据回查。只有时间、参与人或主题线索时，结果标为「可能相关」。用户确认后，候选记忆才会进入长期记忆。
- 源数据库和 WAL 只读，解密快照在内存中维护。主动导出会生成明文 SQLite 文件。DSH 的索引和已确认记忆会写到本机，模型在用户授权后可收到匹配片段。详见 [数据安全说明](SECURITY.md)。
- 可见历史和附件取决于企业微信已同步到这台设备的数据。Windows 格式读取在核心中有合成测试，Windows 真实档案和安装包尚未验收。

## 开发和贡献

原生端使用 SwiftUI，DSH 插件使用 React 和 TypeScript。两端共用 Bun 编译的读取核心。目录、进程通信和索引流程见 [代码架构](docs/architecture.md)，构建检查、测试命令和反馈格式见 [贡献指南](CONTRIBUTING.md)。

## 许可证

本项目的源码和文档采用 MIT 许可证。分发副本或实质性部分时，须保留版权声明和许可文本。 [LICENSE](LICENSE)

第三方组件沿用各自的许可证。wxSQLite3 兼容实现参考了 SQLite3MultipleCiphers 的 MIT 源码。`cipher_wxaes128.c` 的版权为 © 2006–2024 Ulrich Telle，`cipher_common.c` 的版权为 © 2006–2026 Ulrich Telle。 [上游许可证](https://github.com/utelle/SQLite3MultipleCiphers/blob/main/LICENSE)
