---
name: command
types: command
---

# Skill：指令扩展开发（command）

你正在实现一个 **command 类型**的 UniBot 扩展。本技能文件是你在编码阶段的专用指导，与 `system` 提示词、`coding` 任务提示词一起生效。

## 指令扩展要点

- 指令类继承 `Command`，类属性 `name`（指令名，小写）、`description`（中文描述）、`usage`（用法示例）
- 用 `@extension.register_command` 装饰器登记，装饰器必须作用于扩展实例（模块导入时已创建 `extension`）
- 指令实现放在 `handler` 方法中；参数通过 `declare()` 中 `self.register_option(...)` 声明，
  处理器参数使用 Uninfo 会话与 Match 类型：
  ```python
  async def handler(self, session: Uninfo, city: Match[str]) -> str | None:
      ...
  ```
- 返回 `str` 即直接回复；返回 `None` 表示不回复；需要图片渲染时返回模板名与数据（见渲染器约定）
- 空值处理：可选参数必须处理 `Match` 的 `available` 为 False 的情况
- 内置指令若已存在同名，扩展指令会覆盖内置行为——规划阶段应确认这是用户想要的

## 编码规范（摘自本地编码规范文档）

- 变量/函数 `snake_case`、常量 `UPPER_SNAKE`、类 `PascalCase`；禁止自造缩写
- 异步优先：网络/IO 用 async；方法签名带类型注解
- 错误处理：不吞异常，用户可见错误用中文、通俗
- 日志用 `extension.logger`，不用 `print`
- 在 `tests/` 下写 pytest 测试：正常场景、空值、异常、边界

## 完成后

在 `PLAN.md` 底部追加「实现记录」小节，列出实际完成的功能与配置项。
