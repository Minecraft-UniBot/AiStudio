# Studio 内置文档副本

本目录是 UniBot 权威文档的**只读副本**，供 Extension Studio 的 OpenCode 会话直接读取，
使 AI 不依赖 UniBot 目录的绝对路径、也不会因「目录外禁止读取」而去联网搜索本项目内容。

## 来源映射

| 本目录文件 | 源文件（仓库内） |
|-----------|----------------|
| `开发插件.md` | `UniBot/Docs/docs/unibot/开发插件.md` |
| `扩展系统.md` | `UniBot/Docs/docs/unibot/扩展系统.md` |
| `配置说明.md` | `UniBot/Docs/docs/unibot/配置说明.md` |
| `上传市场.md` | `UniBot/Docs/docs/unibot/上传市场.md` |
| `接口文档.md` | `UniBot/Docs/docs/unibot/接口文档.md` |
| `编码规范.md` | `UniBot/AGENT.md` |

## 同步方式

UniBot 文档更新后，运行：

```bash
bun run scripts/sync_docs.ts
```

（在 `Studio/server/` 下执行；脚本会覆盖复制上述源文件。）

> ⚠️ 本目录文件由后端注入为 OpenCode 只读白名单，**不要直接修改**；需要更新文档请改源文件后同步。
