---
name: api
types: api
---

# Skill：API 服务扩展开发（api）

你正在实现一个 **api 类型**的 UniBot 扩展。本技能文件是你在编码阶段的专用指导，与 `system` 提示词、`coding` 任务提示词一起生效。

## API 扩展要点

- 服务类继承 `Service`，用 `@extension.register_service` 装饰器登记
- `Service` 提供的公共方法就是给其它扩展/系统调用的 API；
  方法命名 `snake_case`，返回纯数据（dict / dataclass），不做消息渲染
- API 扩展通常配合 `config_model` 暴露配置（如 API 地址、密钥、开关）
- 若同时提供指令入口（types 含 command），在 `Commands.py` 中实现指令并注入服务：
  ```python
  service = extension.api.get('weather')
  ```
- 服务应做失败隔离：内部异常转成明确错误返回，不抛出到调用方

## 编码规范（摘自本地编码规范文档）

- 变量/函数 `snake_case`、常量 `UPPER_SNAKE`、类 `PascalCase`；禁止自造缩写
- 异步优先：网络/IO 用 async；方法签名带类型注解
- 配置用 Pydantic `BaseModel`；敏感字段（key/token）不落日志
- 错误处理：不吞异常，用户可见错误用中文、通俗
- 日志用 `extension.logger`，不用 `print`
- 在 `tests/` 下写 pytest 测试：正常场景、空值、异常、边界

## 完成后

在 `PLAN.md` 底部追加「实现记录」小节，列出实际完成的 API 与配置项。
