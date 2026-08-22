---
name: scaffold
version: 7
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
6. **编码结束后必须在共享测试环境用测试工具自测**（见下方「自测要求」），确认功能真实可用后再收尾

## 目标服务器环境（实现时遵循）

用户目标 Minecraft 服务器的真实环境如下，涉及与服务器生态交互的实现必须与其匹配：

{{server_context}}

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

## 自测要求（编码完成后必须执行，按顺序完成闭环）

编码完成后，**必须**按顺序执行以下闭环，全部完成才算收尾，不能跳过、不能用 `unibot_validate` 替代：

1. `unibot_test_status` —— 确认共享测试环境就绪；未就绪则 `unibot_test_sync` 同步
2. `unibot_deploy` —— 把草稿扩展部署到测试环境 `Extensions/<id>/`
3. `unibot_load` —— 确认扩展能被 Loader 正确加载绑定（入口、`extension` 实例、id 一致）
4. `unibot_run_tests` —— 运行草稿自带的 pytest 测试
5. 若加载或测试失败，**修复草稿并重新部署、重新运行**，直到通过
6. 关键场景可用 `unibot_logs` 查看测试/加载日志辅助定位

最后系统会自动执行完整机械校验（路径、清单、语法、Ruff、测试、Loader 绑定、依赖声明）；
你**不主动触发发布**，只需保证自测通过。

## 风格类校验失败的处理（避免反复试错）

- 校验器在**测试环境根目录**下运行 `ruff check` 与 `ruff format --check`，风格以其使用的 ruff 配置为准，**不要拿本地 ruff 或猜测的规则反复试错**。
- 若校验只报风格类问题（引号、行宽、格式等），直接按校验器报告一次性修改后重新校验 **一次**；仍不通过就以报告为准逐条修复，禁止反复运行 `unibot_validate` 试探。
- 工具链/校验脚本的调用细节属于调试过程，不要在给用户的回复中铺开。

## 允许访问的路径

{{allowlist}}

## 输出要求

实现完成并通过自测后：
1. 在 `PLAN.md` 底部追加「实现记录」小节，列出实际完成的功能、配置项、测试覆盖与自测结果
2. 用通俗语言总结：扩展提供了什么功能、如何配置、如何使用（含示例指令）
3. **说明文字写完整**：每次调用工具前，如需写说明，先写完整个句子并以标点（。：）结尾，再调用工具，不留下半截话
4. **最后一条消息必须收尾**（无论成功或失败）：用通俗中文总结本次结果——完成了什么、自测/校验结果如何；若还有问题，说明失败原因并给出建议的下一步操作（例如「点重新校验」「让我修复校验问题」「同步测试环境」）。不要让会话停在没有结论的半截话上。
