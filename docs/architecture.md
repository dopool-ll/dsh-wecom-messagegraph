# 代码架构

```text
apps/macos/
  Sources/WeComLocal/
    App/          App 生命周期、企业选择、同步状态
    Core/         Swift 协议模型、进程通信、缓存文件读取
    Features/     档案、会话、通讯录、消息视图
  Resources/      App 图标和包信息
plugins/dsh/
  client/         DSH 面板注册、档案和消息组件
  server/         宿主路由、MessageGraph、Copilot、CLI 和 MCP
  test/           索引、检索、授权和模型响应测试
  locale/         插件名称和描述
packages/wecom-core/
  src/            档案发现、同步、目录查询、富消息和媒体定位
  src/storage/    wxSQLite3、WAL、增量页合并
  test/           合成数据库、WAL、消息和导出测试
  build.ts        macOS 读取程序的编译和签名
```

## 本地读取

两端分别启动自己的 `wecom-core` 子进程，可以单独安装和运行。原生 App 直接通过标准输入输出通信。DSH 面板先调用宿主的本机接口，再由宿主向读取进程请求数据。DSH 的浏览和索引使用各自的读取进程，使后台索引可以读取获授权档案。

标准输入输出使用逐行 JSON。请求是 `{id, request: {op, ...}}`，响应是 `{id, data}` 或 `{id, error}`。请求和返回字段以 [TypeScript 协议](../packages/wecom-core/src/types.ts) 及 [Swift 模型](../apps/macos/Sources/WeComLocal/Core/CoreProtocol.swift) 为准。修改字段时，需要同步核对 Swift 解码和 DSH 的路由校验。诊断信息不应输出到协议标准输出。

核心负责验证 VID、读取主库和 WAL、应用已提交的页，验证通过后才替换内存中的 SQLite 快照。媒体仅从已定位并核验的本机缓存读取。导出从最后一次成功的快照生成新文件夹，拒绝将数据库导出到企业微信数据目录。数据完整性限于当前设备仍可读取的本地文件；未知会话分类不会被强行推断。

## MessageGraph 与模型访问

索引按授权范围保存。DSH 宿主检查本机快照的版本，增量更新变化的会话。SQLite 事务发布索引，读取方可以继续使用上一份已提交的结果。Desktop 与网页端使用同一数据目录时，由数据库租约协调索引写入。

| 代码 | 职责 |
| --- | --- |
| [messagegraph-indexer.js](../plugins/dsh/server/messagegraph-indexer.js) | 扫描授权会话，提取正文、图片 OCR、语音转写和资料线索 |
| [context-store.js](../plugins/dsh/server/context-store.js) | 保存授权、SQLite 全文索引、证据引用和已确认记忆 |
| [messagegraph.js](../plugins/dsh/server/messagegraph.js) | 关键词和筛选查询，匹配共享资料与跨会话线索 |
| [context.js](../plugins/dsh/server/context.js) | DSH 工具入口，回查引用、时间线和本机原消息 |
| [conversation-copilot.js](../plugins/dsh/server/conversation-copilot.js) | 从当前会话选择证据，调用 DSH 默认模型，向面板逐段返回回答 |
| [messagegraph-cli.js](../plugins/dsh/server/messagegraph-cli.js) | 校验独立令牌，以只读方式使用同一份索引 |

索引里的证据引用用来定位消息。打开原文时，插件检查当前授权与消息指纹，再从本机档案取回记录。没有明确引用时，时间、参与人和主题提供候选线索。用户确认的记忆可以在授权范围内召回，并保留原消息入口。

## 平台范围

当前应用与打包入口面向 macOS。核心保留 Windows 格式的识别逻辑和合成测试。Windows 真机上的档案发现、VID 派生和读取，以及安装包仍待验收。
