---
name: resources
types: resources
---

# Skill：资源扩展开发（resources）

你正在实现的扩展包含 **resources 类型**部分。资源是纯静态内容（图片、字体、样式片段），不执行任何代码。

## 清单与目录

- `[resources]` 段声明 `root = "Resources"`（资源根目录，相对扩展包根）
- 素材放入 `Resources/`，按用途分子目录管理（如 `Backgrounds/`、`Fonts/`、`Styles/`）
- 常见约定：`Resources/Font.ttf` 作为模板默认字体来源（框架注入 `font_uri`）

## 混合扩展（types 同时含代码能力或 template）

- 仅 `template`/`resources` 的扩展无需入口文件；与代码能力混用时必须保留 `__init__.py` 入口
- 资源部分由框架在代码加载成功后自动静态注册；本扩展自己的模板可直接用 `resource_url('<本扩展id>', '...')` 引用自带素材
- 其他扩展引用本包素材时，需在其清单 `[template].resources` 中声明本扩展 id

## 校验注意

- 机械校验的「模板/资源目录」步骤要求 `Resources/` 目录存在且非空可用
- 素材文件不要过大：路径与大小检查会拒绝超限文件；字体/图片优先选常用格式（ttf/png/jpg/webp）

## 完成后

在 `PLAN.md` 底部追加「实现记录」，列出资源目录结构与各素材的用途。
