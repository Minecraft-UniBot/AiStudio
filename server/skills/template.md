---
name: template
types: template
---

# Skill：模板扩展开发（template）

你正在实现的扩展包含 **template 类型**部分。本技能文件与 `system` 提示词、`coding` 任务提示词一起生效；若扩展同时声明了 command/api/renderer（混合扩展），对应技能也已一并加载。

## 清单与目录

- `[template]` 段声明 `entry = "Templates"`（模板根目录，相对扩展包根）；可选 `resources = ["OtherExt"]` 声明依赖的资源扩展 id
- 模板文件放在 `Templates/` 下，按模板名组织（如 `Templates/Card.html`），配套样式同名 `.css`
- 可用 `[template.config_schema.<字段>]` 声明受限配置字段供用户在 WebUI 定制外观：
  - 类型六选一：`string` / `integer` / `number` / `boolean` / `color` / `select`
  - 每项必须提供 `type` 与 `default`；`select` 必须提供非空 `options` 且默认值包含在其中
  - 字段名必须合法标识符且不以下划线开头；可选 `title`、`description`、数值 `min`/`max`、字符串 `min_length`/`max_length`

## 模板上下文

- 每次渲染注入当前配置快照：`{{ config.primary_color }}`；另有框架保留名 `width`、`height`、`font_uri` 与资源函数，调用方字段不得覆盖
- 引用资源扩展素材用 Jinja 函数（不直接写本地路径）：
  - `resource_url('ExtId', 'Backgrounds/default.png')` / `resource_path(...)` 返回由渲染引擎转换的引用
  - `resource_text(...)` / `resource_bytes(...)` 读文本/二进制；`random('ExtId', 'Backgrounds')` 从目录随机选图
- 模板只能从自身声明的目录加载文件，禁止 `..`、绝对路径或符号链接越界

## 混合扩展（types 同时含代码能力）

- 必须保留 `__init__.py` 入口；模板部分由框架在代码加载成功后自动静态注册，无需手动注册
- 在指令/API 中渲染图片并返回：

```python
data = await self.fetch_data()
return await extension.render_image(
    'Card',                       # 模板包内的模板名
    (600, 0),                     # 尺寸，高度 0 表示自适应
    context={'items': data},      # 模板中 {{ items }} 直接可用
)
```

- 上下文中的本地文件用 `FileAsset(Path(...))` 标记、在线图片用 `OnlineAsset(url)` 标记，框架会在渲染前交给当前渲染器转换
- 图片模式关闭、模板不存在或渲染器不可用时会有明确异常，指令应处理并给出中文提示

## 校验注意

- 机械校验的「模板/资源目录」步骤要求 `Templates/` 目录存在；混合扩展还会跑完整代码校验（语法/Ruff/测试/Loader）
- 平台提供模板可视化预览（工作区右侧），实现后建议让用户预览效果

## 完成后

在 `PLAN.md` 底部追加「实现记录」，列出模板名清单、`config_schema` 字段与依赖的资源扩展。
