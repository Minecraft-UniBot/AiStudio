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
- 不使用 Unibot 的 Scripts 包，仅依赖 jinja2；模板可调用与 UniBot Renderer 语义一致的
  资源全局函数（random / resource_path / resource_url / resource_text / resource_bytes），
  它们解析草稿工作区自己的 Resources/ 目录（<Templates 的上级>/Resources）：
  * 图片类输出内联 data URI，iframe srcdoc 无基准地址也能直接显示；
  * resource_text / resource_bytes 读取文件内容（沿用 2 MiB 单次上限）；
  * random("扩展id", "目录") 从目录稳定挑选一张方块纹理并返回 url("data:...")；
  * font_uri 优先内联草稿 Resources/Font.ttf（超过 6 MiB 时回退系统字体）。
- 模板配置：config.* 取草稿 Extension.toml 的 [template.config_schema] 默认值，含 {{ }}
  的字符串字段按声明顺序预渲染（与 Renderer._config_context 一致），
  因此 config.primary_color / config.background 等在预览中不再为空。
- 仅读取草稿工作区内文件，资源路径校验禁止越界（resolve + is_relative_to），不写任何文件。

输出：完整 HTML 文档到 stdout（UTF-8）。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import random as _random
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

try:
    import tomllib
except ImportError:  # pragma: no cover - Python < 3.11 无标准库 tomllib
    tomllib = None

# 单次资源读取上限（与 UniBot Renderer 的 _RESOURCE_MAX_BYTES 一致）
_RESOURCE_MAX_BYTES = 2 * 1024 * 1024
# 字体内联上限：超出后预览回退系统字体，避免 srcdoc 过大
_FONT_MAX_BYTES = 6 * 1024 * 1024

# 资源文件 → data URI 的 MIME 映射（缺省 application/octet-stream）
_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".css": "text/css",
    ".txt": "text/plain",
    ".md": "text/plain",
    ".json": "application/json",
    ".toml": "text/plain",
}
# random(...) 可挑选的图片后缀
_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".svg"})

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


class PreviewResourceError(Exception):
    """资源解析失败（路径越界 / 文件缺失 / 超出大小限制）。"""


# ---------- 资源解析 ----------


def _mime_for(path: Path) -> str:
    return _MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")


def _data_uri(path: Path) -> str:
    """文件内联为 data URI（iframe srcdoc 无基准地址，只有 data: 能直接显示）。"""
    mime = _mime_for(path)
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _resolve_resource(resources_root: Path, relative_path: str) -> Path:
    """把模板传入的相对路径解析到草稿资源根，禁止绝对路径、`..` 与符号链接越界。"""
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise PreviewResourceError(f"资源路径非法：{relative_path}")
    root = resources_root.resolve()
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise PreviewResourceError(f"资源路径越界：{relative_path}")
    return candidate


def _install_resource_globals(env: Environment, resources_root: Path) -> None:
    """安装与 UniBot Renderer 全局函数（random/resource_path/resource_url/resource_text/resource_bytes）
    语义一致的最小实现。Studio 预览只有草稿自己的资源集合，任意扩展 id 都解析到草稿 Resources/。
    资源根目录不存在时（纯模板草稿）静默回退空值，与旧行为一致；根存在但文件缺失时抛错，便于发现问题。
    """
    root_exists = resources_root.is_dir()

    def random_image(extension_id: str, directory: str) -> str:
        if not root_exists:
            return ""
        try:
            candidate = _resolve_resource(resources_root, directory)
        except PreviewResourceError:
            return ""
        if not candidate.is_dir():
            return ""
        images = sorted(
            p for p in candidate.iterdir()
            if p.is_file() and p.suffix.lower() in _IMAGE_SUFFIXES
        )
        if not images:
            return ""
        # 预览求稳定：以目录路径为种子，同目录多次渲染选同一张图，避免 re-render 时背景抖动
        seed = int.from_bytes(hashlib.md5(str(candidate).encode()).digest()[:8], "big")
        picked = _random.Random(seed).choice(images)
        return f'url("{_data_uri(picked)}")'

    def resource_path(extension_id: str, relative_path: str) -> str:
        if not root_exists:
            return ""
        path = _resolve_resource(resources_root, relative_path)
        if not path.is_file():
            raise PreviewResourceError(f"资源文件不存在：{relative_path}")
        return str(path)

    def resource_url(extension_id: str, relative_path: str) -> str:
        if not root_exists:
            return ""
        path = _resolve_resource(resources_root, relative_path)
        if not path.is_file():
            raise PreviewResourceError(f"资源文件不存在：{relative_path}")
        if path.stat().st_size > _RESOURCE_MAX_BYTES:
            raise PreviewResourceError(
                f"资源文件过大：{relative_path}（{path.stat().st_size} 字节 > {_RESOURCE_MAX_BYTES}）"
            )
        return _data_uri(path)

    def resource_text(extension_id: str, relative_path: str, encoding: str = "Utf-8") -> str:
        if not root_exists:
            return ""
        path = _resolve_resource(resources_root, relative_path)
        if not path.is_file():
            raise PreviewResourceError(f"资源文件不存在：{relative_path}")
        data = path.read_bytes()
        if len(data) > _RESOURCE_MAX_BYTES:
            raise PreviewResourceError(
                f"资源文件过大：{relative_path}（{len(data)} 字节 > {_RESOURCE_MAX_BYTES}）"
            )
        return data.decode(encoding)

    def resource_bytes(extension_id: str, relative_path: str) -> bytes:
        if not root_exists:
            return b""
        path = _resolve_resource(resources_root, relative_path)
        if not path.is_file():
            raise PreviewResourceError(f"资源文件不存在：{relative_path}")
        data = path.read_bytes()
        if len(data) > _RESOURCE_MAX_BYTES:
            raise PreviewResourceError(
                f"资源文件过大：{relative_path}（{len(data)} 字节 > {_RESOURCE_MAX_BYTES}）"
            )
        return data

    env.globals["random"] = random_image
    env.globals["resource_path"] = resource_path
    env.globals["resource_url"] = resource_url
    env.globals["resource_text"] = resource_text
    env.globals["resource_bytes"] = resource_bytes


# ---------- 草稿 Extension.toml（config_schema / resources.root） ----------


def _parse_toml_value(raw: str):
    """最小 TOML 值解析：带引号字符串 / 整数 / 浮点 / 布尔 / 原样文本。"""
    value = raw.strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    low = value.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def _minimal_toml_parse(text: str) -> dict:
    """Python < 3.11 无 tomllib 时的兜底：只提取 [resources].root 与 [template.config_schema.*] 的字段元信息。"""
    result: dict = {}
    section = ""
    current_field: dict | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            current_field = None
            if section.startswith("template.config_schema."):
                name = section[len("template.config_schema."):].strip()
                current_field = (
                    result.setdefault("template", {})
                    .setdefault("config_schema", {})
                    .setdefault(name, {})
                )
            continue
        if "=" not in line:
            continue
        key, _, raw = line.partition("=")
        key = key.strip()
        raw = raw.strip()
        if current_field is not None and key in ("type", "default"):
            current_field[key] = _parse_toml_value(raw)
        elif section == "resources" and key == "root":
            result.setdefault("resources", {})["root"] = _parse_toml_value(raw)
    return result


def _read_extension_toml(extension_dir: Path) -> dict:
    """读取草稿 Extension.toml；缺失/解析失败返回空 dict（config 回退默认上下文）。"""
    toml_path = extension_dir / "Extension.toml"
    if not toml_path.is_file():
        return {}
    try:
        text = toml_path.read_text("utf-8", errors="replace")
    except OSError:
        return {}
    if tomllib is not None:
        try:
            loaded = tomllib.loads(text)
            return loaded if isinstance(loaded, dict) else {}
        except Exception:  # noqa: BLE001
            return {}
    return _minimal_toml_parse(text)


def _resource_root_name(manifest: dict) -> str:
    """清单 [resources].root（缺省 'Resources'）。"""
    resources = manifest.get("resources")
    if isinstance(resources, dict):
        root = resources.get("root")
        if isinstance(root, str) and root.strip():
            return root.strip()
    return "Resources"


def _build_config(manifest: dict, env: Environment, context: dict | None) -> dict:
    """模板 config：Extension.toml [template.config_schema] 的默认值 + Jinja 预渲染。

    与 UniBot Renderer._config_context 语义一致：string 字段含 {{ }} 时按声明顺序
    用同一 Jinja 环境渲染（后字段可见前字段结果），因此
    background = "{{ random(\"Default\", \"Backgrounds\") }}" 这类配置在预览中能真正解析。
    清单缺失或没有 config_schema 时回退默认上下文（纯渐变背景）。
    """
    fallback = dict(DEFAULT_CONTEXT["config"])
    schema = (manifest.get("template") or {}).get("config_schema")
    if not isinstance(schema, dict) or not schema:
        return fallback
    values: dict = {}
    for name, field in schema.items():
        if isinstance(field, dict) and "default" in field:
            values[name] = field["default"]
    for name, value in list(values.items()):
        if isinstance(value, str) and "{{" in value:
            try:
                values[name] = env.from_string(value).render(**values)
            except Exception:  # noqa: BLE001 - 预渲染失败时该字段回退空串，不阻断预览
                values[name] = ""
    overrides = context.get("config") if isinstance(context, dict) else None
    if isinstance(overrides, dict):
        values.update(overrides)
    return values


def _resolve_font_uri(resources_root: Path) -> str:
    """草稿 Resources/Font.ttf 内联为 data URI；缺失或超限时回退空串（浏览器用系统字体）。"""
    if not resources_root.is_dir():
        return ""
    font = resources_root / "Font.ttf"
    try:
        if font.is_file() and font.stat().st_size <= _FONT_MAX_BYTES:
            return _data_uri(font)
    except OSError:
        pass
    return ""


# ---------- 渲染 ----------


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
    """渲染指定模板为完整 HTML 文档（含草稿资源解析与模板配置注入）。"""
    extension_dir = templates_dir.parent.resolve()
    manifest = _read_extension_toml(extension_dir)
    resources_root = extension_dir / _resource_root_name(manifest)

    env = Environment(
        loader=FileSystemLoader(str(templates_dir)),
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    _install_resource_globals(env, resources_root)

    ctx = {**_context(context), **(data or {})}
    ctx["font_uri"] = _resolve_font_uri(resources_root)
    if isinstance(context, dict) and context.get("font_uri"):
        ctx["font_uri"] = context["font_uri"]
    if isinstance(data, dict) and data.get("font_uri"):
        ctx["font_uri"] = data["font_uri"]
    ctx["config"] = _build_config(manifest, env, context)
    if isinstance(data, dict) and isinstance(data.get("config"), dict):
        ctx["config"].update(data["config"])

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
    # font_uri 由渲染时按草稿资源解析（见 render_document），这里不预填空串避免覆盖解析结果
    merged = {key: value for key, value in DEFAULT_CONTEXT.items() if key not in ("config", "font_uri")}
    if ctx:
        for key, value in ctx.items():
            if key not in ("config", "font_uri"):
                merged[key] = value
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

    try:
        html = render_document(tdir, template, merged_data, context)
    except Exception as exc:  # noqa: BLE001
        print(f"模板渲染失败：{exc}", file=sys.stderr)
        return 1
    sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())