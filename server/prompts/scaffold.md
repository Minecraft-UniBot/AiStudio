---
name: scaffold
version: 4
---

# 第二阶段：实现编码

第一阶段（规划）已完成，规划文档已写入工作区 `PLAN.md`。

## 你的任务

1. **先读取 `PLAN.md`**（工作区根目录），严格按规划实现，不要偏离规划；规划未覆盖的细节按需自行决策并在「实现记录」中说明
2. **参考已有扩展**：读取本地扩展市场注册表 `{{market_path}}`（只读），
   优先复用市场中已有扩展的能力（服务 API、指令），避免重复造轮子；如需复用，直接调用其公共 API
3. 按对应 skill（已随 system 提示词加载）实现代码与测试
4. 更新 `Extension.toml`：补全 `[extension]` 元数据与 `[dependencies]` 声明
5. 在 `tests/` 下编写/补全 pytest 测试

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

实现完成后：
1. 在 `PLAN.md` 底部追加「实现记录」小节，列出实际完成的功能、配置项与测试覆盖
2. 用通俗语言总结：扩展提供了什么功能、如何配置、如何使用（含示例指令）
3. **说明文字写完整**：每次调用工具前，如需写说明，先写完整个句子并以标点（。：）结尾，再调用工具，不留下半截话
