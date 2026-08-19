"""
UniBot 模板预览渲染脚本（Extension Studio 专属，位于 Studio 目录内）。

由 Studio 后端以子进程调用，把草稿工作区 Templates 目录下的某个模板用 Jinja2
渲染成完整的 HTML 文档（含内联 Base.css 与模板自身 CSS），供前端 iframe srcdoc 预览：

  <unibot>/.venv/bin/python <studio>/server/validation/preview_template.py \
      --templates-dir <草稿>/Templates --template Server                          # preview one template

  <unibot>/.venv/bin/python <studio>/server/validation/preview_template.py \
      --templates-dir <草稿>/Templates --list                                      # list template names

说明：
- 模板为 Jinja2，Base.css 也含 `{{ width }}` / `{{ config.background }}` 变量，因此由本脚本
  在同一 Jinja2 环境里一起渲染后再组装成完整 HTML（浏览器 iframe 无法直接渲染 Jinja2）。
- 测试数据为内置占位数据（Server/List/Luck/About/Bound/Help），可用 --data 以 JSON 覆盖。
- 不使用 Unibot 的 Scripts 包，仅依赖 jinja2；如模板额外需要框架内置全局函数（random/
  resource_url 等），这里提供最小实现避免预览报错。

输出：完整 HTML 文档到 stdout（UTF-8）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

# 预览用渲染尺寸/上下文（对应 Base.css 里的 {{ width }} / {{ height }} / {{ font_uri }} / {{ config }}）
DEFAULT_CONTEXT = {
    "width": 720,
    "height": 760,
    "font_uri": "",
    "config": {
        "background": "linear-gradient(150deg, #2e4a30 0%, #1d3524 55%, #12241a 100%)",
    },
}

# 各模板的占位测试数据（开发者手编，供 iframe 预览）
DEFAULT_DATA: dict = {
    "Server": {
        "servers": [
            {"name": "生存服务器", "index": 1},
            {"name": "小游戏服务器", "index": 2},
            {"name": "创造服务器", "index": 3},
        ],
    },
    "List": {
        "player_list": {
            "生存服务器": {
                "real_players": ["Steve", "Alex", "Notch", "Herobrine"],
                "fake_players": ["Bot_001", "Bot_002"],
            },
            "小游戏服务器": {
                "real_players": ["c_nian", "小明"],
                "fake_players": [],
            },
        },
        "avatars": {},
    },
    "Luck": {
        "luck_point": 88,
        "good_thing": "适合挑战大型建筑",
        "bad_thing": "不宜进行 PvP 大战",
    },
    "About": {
        "version": "v1.0.1",
        "has_update": False,
    },
    "Bound": {
        "bindings": [
            {"user": "小明", "players": ["Steve", "Alex"]},
            {"user": "小红", "players": ["c_nian"]},
        ],
    },
    "Help": {
        "detail": None,
        "commands": [
            {"usage": "/server", "description": "查看服务器连接状态"},
            {"usage": "/list", "description": "查看在线玩家列表"},
            {"usage": "/help <name>", "description": "查看指定命令的帮助与参数说明"},
        ],
    },
}


def _builtin_globals(env: Environment) -> None:
    """给模板注入 framework 常见全局函数的最小实现（预览用，资源路径为空字符串）。"""
    env.globals["random"] = lambda *a, **k: ""
    env.globals["resource_path"] = lambda *a, **k: ""
    env.globals["resource_url"] = lambda *a, **k: ""
    env.globals["resource_text"] = lambda *a, **k: ""
    env.globals["resource_bytes"] = lambda *a, **k: b""


def list_templates(templates_dir: Path) -> list[str]:
    """扫描 Templates 根，返回含 <Name>/<Name>.html 的模板名（按字母序）。"""
    names: list[str] = []
    if templates_dir.is_dir():
        for child in sorted(templates_dir.iterdir()):
            if child.is_dir() and (child / f"{child.name}.html").exists():
                names.append(child.name)
        # 顶层也可能直接放 <Name>.html（无子目录），一并识别
        for f in sorted(templates_dir.glob("*.html")):
            name = f.stem
            if name.lower() != "base" and name not in names:
                names.append(name)
    return names


def render_document(
    templates_dir: Path,
    template: str,
    data: dict | None,
    context: dict | None,
) -> str:
    """渲染指定模板为完整 HTML 文档。"""
    env = Environment(
        loader=FileSystemLoader(str(templates_dir)),
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    _builtin_globals(env)
    ctx = {**_context(context), **(data or {})}
    # 页体内芯：模板（含 {% extends "Base.html" %}）
    tpl = f"{template}/{template}.html"
    if not (templates_dir / tpl).exists():
        # 允许顶层 <Name>.html
        tpl = f"{template}.html"
    body = env.get_template(tpl).render(**ctx)
    # 样式：Base.css + 模板自身 CSS（同为 Jinja2，合并渲染）
    styles: list[str] = []
    for css in ("Base.css", f"{template}/{template}.css", f"{template}.css"):
        css_path = templates_dir / css
        if css_path.exists():
            styles.append(env.get_template(css).render(**ctx))
    css_block = "\n".join(styles)
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<style>{css_block}</style></head><body>{body}</body></html>"
    )


def _context(ctx: dict | None) -> dict:
    merged = {**DEFAULT_CONTEXT}
    if ctx:
        merged.update(ctx)
        cfg = dict(DEFAULT_CONTEXT["config"])
        cfg.update(ctx.get("config") or {})
        merged["config"] = cfg
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description="UniBot 模板预览渲染（Studio 专用）")
    parser.add_argument("--templates-dir", type=Path, required=True, help="草稿的 Templates 根目录")
    parser.add_argument("--template", type=str, default="", help="模板名（如 Server）；省略时预览第一个可用模板")
    parser.add_argument("--list", action="store_true", help="只列出可用模板名（每行一个）")
    parser.add_argument("--data", type=str, default="", help="可选 JSON 数据，覆盖内置占位数据（按模板名合并）")
    parser.add_argument("--context", type=str, default="", help="可选 JSON 渲染上下文（width/height/font_uri/config）")
    args = parser.parse_args()

    tdir = args.templates_dir.resolve()
    if not tdir.is_dir():
        print(f"模板目录不存在：{tdir}", file=sys.stderr)
        return 2

    if args.list:
        for name in list_templates(tdir):
            print(name)
        return 0

    names = list_templates(tdir)
    if not names:
        print("模板目录中没有可预览的模板", file=sys.stderr)
        return 2
    template = args.template or names[0]
    if template not in names:
        print(f"模板「{template}」不存在，可用：{', '.join(names)}", file=sys.stderr)
        return 2

    data: dict = {}
    if args.data:
        try:
            supplied = json.loads(args.data)
            if isinstance(supplied, dict):
                # 支持 { "Server": {...} } 或直接 { ... } 两种形态：按模板名取，取不到则整体作为数据
                data = supplied
        except Exception as exc:  # noqa: BLE001
            print(f"data JSON 解析失败：{exc}", file=sys.stderr)
            return 2

    context: dict | None = None
    if args.context:
        try:
            parsed = json.loads(args.context)
            context = parsed if isinstance(parsed, dict) else None
        except Exception:  # noqa: BLE001
            context = None

    per_template = DEFAULT_DATA.get(template)
    merged_data: dict = {}
    if isinstance(per_template, dict):
        merged_data.update(per_template)
    if isinstance(data, dict):
        for key, val in data.items():
            if key in DEFAULT_DATA and isinstance(val, dict):
                merged_data[key] = val  # 整包覆盖某模板数据
            else:
                merged_data[key] = val
    elif isinstance(data, dict):  # 数据直接是模板字段
        merged_data.update(data)

    try:
        html = render_document(tdir, template, merged_data, context)
    except Exception as exc:  # noqa: BLE001
        print(f"模板渲染失败：{exc}", file=sys.stderr)
        return 1
    sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main())