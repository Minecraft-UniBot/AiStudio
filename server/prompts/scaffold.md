---
name: scaffold
version: 1
---

# 生成任务

为用户创建 UniBot 扩展「{{name}}」（{{extension_id}}，类型：{{types}}）。

## 原始需求

{{user_request}}

## 扩展规范要点

- 扩展目录名与 Extension.toml 中 `extension.id` 必须完全一致（含大小写）：{{extension_id}}
- 入口 `__init__.py` 必须导出 `extension` 实例：
  ```python
  from Scripts.Extensions import Extension
  extension = Extension()
  ```
- 需要注册能力时，在 `extension` 创建之后导入能力模块：
  ```python
  from . import Commands  # noqa: E402,F401
  ```
- 指令类继承 `Command`，通过 `@extension.register_command` 装饰器登记
- API 服务继承 `Service`，通过 `@extension.register_service` 登记
- 配置使用 Pydantic `BaseModel` 作为 `config_model`
- 在 `tests/` 下编写 pytest 测试（需要 `Scripts.Extensions` 时用真实 import）

## 允许访问的路径

{{allowlist}}

## 输出要求

实现完成后，用通俗语言总结：扩展提供了什么功能、如何配置、如何使用（含示例指令）。
