# 原生 macOS App

使用 SwiftUI 窗口和菜单栏，支持在本机浏览企业档案、搜索会话和联系人、筛选会话类型与已读状态、查看历史消息、预览缓存图片及保存附件。关窗后，已选档案继续同步；可从菜单栏重新打开窗口、暂停或退出。完成首次同步后，可通过系统目录选择器导出 SQLite 快照。

## 构建与运行

需要 macOS 13 或以上、Xcode 15 或以上，以及 Bun。从仓库根目录运行：

```sh
bun apps/macos/build.ts
open "apps/macos/dist/WeCom Local.app"
```

脚本按本机构建架构生成 Apple 芯片或 Intel 芯片版本，将读取程序放进 App 包并做本地签名。产物用于本机开发，未做发行签名或公证。打开后选择企业档案；如果 macOS 提示无法访问企业微信数据，按系统提示授权后重新扫描。

用 Xcode 打开 `apps/macos/Package.swift` 可查看和编辑工程。完整运行需使用上述 App 包，其中包含原生端调用的读取程序。可用已打包的读取程序验证 Swift 与核心之间的通信：

```sh
WECOM_TEST_CORE="$PWD/apps/macos/dist/WeCom Local.app/Contents/MacOS/wecom-core" \
  swift test --package-path apps/macos
```

原生端可以保存本地音视频缓存；语音解码与内嵌音视频播放目前由 DSH 插件提供。历史消息和附件是否可用取决于本机客户端已写入的数据。
