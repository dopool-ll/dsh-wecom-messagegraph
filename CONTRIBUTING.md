# 贡献指南

从现有 [代码架构](docs/architecture.md) 找到改动所属的模块。源库识别、解密、WAL 和消息格式在 `packages/wecom-core`。原生窗口在 `apps/macos`。Agent 检索、Copilot、CLI 与 MCP 在 `plugins/dsh`。

## 在本机验证

在 macOS 的仓库根目录执行。工具版本和启动步骤见 [README](README.md#快速开始)。

```sh
# 核心读取、消息解析与数据库快照
bun test packages/wecom-core

# DSH 类型检查、索引与权限测试
(cd plugins/dsh && npm ci --ignore-scripts)
npm --prefix plugins/dsh run check
node --test plugins/dsh/test/*.test.js

# 原生 App 构建及读取进程通信测试
bun apps/macos/build.ts
WECOM_TEST_CORE="$PWD/apps/macos/dist/WeCom Local.app/Contents/MacOS/wecom-core" \
  swift test --package-path apps/macos
```

插件界面、宿主连接或打包变更，请按 [插件安装步骤](plugins/dsh/README.md#构建和安装) 在本机 DSH 中验证，并注明测试了 Desktop、网页端或两者。索引或媒体改动可用合成数据库和受控缓存复现。模型调用可用本地测试服务，验证首段输出、取消、授权和原消息跳转。

## 提交反馈或改动

- 说明复现步骤、预期结果、实际结果和已验证的环境。涉及数据库兼容性时，请附平台与企业微信版本。
- 使用合成消息、测试账号或彻底脱敏的最小样本。提交前检查暂存区，确认源码、文档和测试之外的本地数据及构建产物没有被误加。
- 涉及敏感信息的报告按 [数据安全说明](SECURITY.md#报告问题) 提交。
