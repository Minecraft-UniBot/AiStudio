---
name: scaffold
version: 2
---

# 生成任务

为用户创建 UniBot 扩展「{{name}}」（{{extension_id}}，类型：{{types}}）。

## 第一步：先读本地文档，禁止联网搜索

动手写代码前，**必须**先只读 Studio 内文档副本（`prompts/docs/`，后端已加入只读白名单）：

1. `开发插件.md`——开发总览、扩展实例、两阶段绑定、能力注册、目录约定
2. `扩展系统.md`——扩展类型、清单（Extension.toml）字段与校验、依赖声明
3. 涉及配置时再读 `配置说明.md`；编写代码时按需查阅 `编码规范.md`

**禁止**用 web_fetch / web_search 搜索「UniBot 扩展」相关内容。第三方库（nonebot2 / alconna / pydantic）用法以本地已安装包为准，确需查官方文档须先征得用户同意。

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
