# i18n 术语表（全批次统一）

所有迁移与翻译必须使用以下术语，保持全项目一致。

## 英→中术语对照

| 英文 | zh-CN | 备注 |
|------|-------|------|
| session | 会话 | 运行中的进程/连接 |
| conversation | 对话 | 历史聊天记录（resume 对话） |
| message | 消息 | |
| tool | 工具 | |
| permission | 权限 | |
| workspace | 工作区 | |
| worktree | 工作树 | git worktree |
| plugin | 插件 | |
| marketplace | 插件市场 | plugin marketplace |
| agent | 代理 | subagent → 子代理 |
| model | 模型 | |
| token | token | 不翻译 |
| context | 上下文 | |
| compact / compaction | 压缩 | 上下文压缩 |
| microcompact | 微压缩 | |
| sandbox | 沙箱 | |
| daemon | 守护进程 | |
| background task | 后台任务 | |
| resume | 恢复 | |
| fork | fork | 不翻译（动词用"派生"时注明） |
| hook | hook | 不翻译 |
| skill | 技能 | |
| workflow | 工作流 | |
| workflow script | 工作流脚本 | |
| memory | 记忆 | |
| settings | 设置 | |
| config / configuration | 配置 | |
| checkpoint | 检查点 | |
| sidechain | 侧链 | 子代理对话链 |
| prompt | 提示词 | 指系统/命令 prompt 时 |
| stream / streaming | 流式 | |
| cache | 缓存 | |
| rate limit | 速率限制 | |
| quota | 配额 | |
| usage | 用量 | token 用量 |
| cost | 成本 | |
| billing | 计费 | |
| OAuth | OAuth | 不翻译 |
| API key | API 密钥 | |
| endpoint | 端点 | |
| provider | 提供商 | |
| IDE | IDE | 不翻译 |
| MCP | MCP | 不翻译 |
| server | 服务器 | |
| client | 客户端 | |
| remote control | 远程控制 | |
| bridge | 桥接 | |
| daemon | 守护进程 | |
| log | 日志 | |
| debug | 调试 | |
| verbose | 详细 | |
| warning | 警告 | |
| error | 错误 | |
| failed to X | 无法 X / X 失败 | 按语感选择 |
| loading / loading… | 加载中 / 加载中… | |
| press X to Y | 按 X 可 Y | |
| enter / type | 输入 | |

## 风格规则

1. 中文用全角标点（，。？！：""），但保留英文半角的技术符号（: / . -（参数分隔））
2. 省略号统一用 `…`（单字符），与 key 保持逐字节一致
3. 快捷键格式保持原样：`Ctrl+C`、`Shift+Tab`、`esc`
4. 数字与英文单词两侧加空格：`已加载 5 条消息`
5. 语气：简洁、命令式为主；对话框按钮用动词开头（"继续"、"取消"）
6. 英文 key 中的占位符 `{{name}}` 必须原样保留在译文中
