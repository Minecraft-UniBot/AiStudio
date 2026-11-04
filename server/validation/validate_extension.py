"""
UniBot 扩展校验脚本（Extension Studio 专属，位于 Studio 目录内）。

由 Studio 后端以受限子进程调用：
  <unibot>/.venv/bin/python <studio>/server/validation/validate_extension.py <扩展目录> --unibot-root <unibot根目录>

约束：
- 本脚本位于 Studio 目录，不修改 UniBot 的任何文件
- 只读复用 UniBot 的 Python 工具链（venv 内的 pydantic/toml/ruff/pytest）
- 通过 sys.path 引入扩展框架包（新版 `Core.Extension` / 旧版 `Scripts.Extensions`）做清单校验与最小绑定测试
- 不调用 ExtensionManager / Loader 的完整加载流程（避免全局注册与状态污染）
- import 边界检查：拒绝扩展导入框架内部注册表（Manager/Loader/Storage 等）

输出：结构化 JSON 到 stdout（{ ok, steps, extension_id }）。
"""
from __future__ import annotations

import argparse
import ast
import importlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path

# 框架内部模块前缀（扩展只能导入包根，禁止深入内部实现）；
# 同时覆盖新版 Core.Extension 与已发布版本的 Scripts.Extensions 两套布局
FORBIDDEN_IMPORT_PREFIXES = (
    'Core.Extension.Runtime',
    'Core.Extension.Market',
    'Core.Extension.Storage',
    'Core.Extension.Errors',
    'Core.Extension.Extension',
    'Scripts.Extensions.Manager',
    'Scripts.Extensions.Loader',
    'Scripts.Extensions.Storage',
    'Scripts.Extensions.Dependencies',
    'Scripts.Extensions.Market',
    'Scripts.Extensions.MarketManager',
    'Scripts.Extensions.Errors',
    'Scripts.Extensions.Base',
)

STEPS: list[dict] = []

_UNIBOT_ROOT: Path | None = None
_FRAMEWORK_PACKAGE: str | None = None


def _step(step_id: str, name: str, ok: bool, message: str = '', detail: str = '') -> None:
    STEPS.append({'id': step_id, 'name': name, 'ok': ok, 'message': message, 'detail': detail})


def _framework_package() -> str:
    """
    扩展框架包前缀：新版 `Core.Extension`，回退已发布版本的 `Scripts.Extensions`。

    以磁盘布局探测（而非试导入）判定，避免探测本身引入框架依赖副作用；
    校验目标版本由 Studio 下载的 UniBot 测试环境决定。
    """
    global _FRAMEWORK_PACKAGE
    if _FRAMEWORK_PACKAGE is None:
        has_new_layout = _UNIBOT_ROOT is not None and (_UNIBOT_ROOT / 'Core' / 'Extension' / '__init__.py').exists()
        _FRAMEWORK_PACKAGE = 'Core.Extension' if has_new_layout else 'Scripts.Extensions'
    return _FRAMEWORK_PACKAGE


def _framework():
    """导入框架包根；两版包根均 re-export 校验所需的全部符号。"""
    return importlib.import_module(_framework_package())


def _is_forbidden_import(target: str) -> bool:
    """判断被导入模块是否属于框架内部（前缀匹配，覆盖 `from X.Y import Z` 形态）。"""
    return any(
        target == prefix or target.startswith(f'{prefix}.')
        for prefix in FORBIDDEN_IMPORT_PREFIXES
    )


def _check_manifest(ext_dir: Path) -> None:
    """清单 schema 校验 + id 与目录名一致（复用框架严格校验）。"""
    framework = _framework()
    parse_manifest = framework.parse_manifest
    ManifestError = framework.ManifestError

    manifest_path = ext_dir / 'Extension.toml'
    if not manifest_path.exists():
        _step('manifest', 'Extension.toml 清单校验', False, '缺少 Extension.toml')
        return
    try:
        manifest = parse_manifest(manifest_path.read_text('utf-8'))
    except ManifestError as error:
        _step('manifest', 'Extension.toml 清单校验', False, str(error))
        return
    if manifest.extension.id != ext_dir.name:
        _step(
            'manifest', 'Extension.toml 清单校验', False,
            f'扩展 id {manifest.extension.id} 与目录名 {ext_dir.name} 不一致（含大小写）',
        )
        return
    if not manifest.extension.types:
        _step('manifest', 'Extension.toml 清单校验', False, '必须声明至少一种扩展类型')
        return
    _step(
        'manifest', 'Extension.toml 清单校验', True,
        f"id={manifest.extension.id} types={[t.value for t in manifest.extension.types]}",
    )


def _read_manifest(ext_dir: Path):
    """读取并解析清单；失败返回 None。"""
    framework = _framework()
    parse_manifest = framework.parse_manifest
    ManifestError = framework.ManifestError

    manifest_path = ext_dir / 'Extension.toml'
    if not manifest_path.exists():
        return None
    try:
        return parse_manifest(manifest_path.read_text('utf-8'))
    except ManifestError:
        return None


def _manifest_type_names(manifest) -> set[str]:
    """清单声明的扩展类型名集合（如 {'template','resources'}）。"""
    if not manifest or not getattr(manifest, 'extension', None):
        return set()
    raw = getattr(manifest.extension, 'types', None) or []
    names: set[str] = set()
    for item in raw:
        v = item.value if hasattr(item, 'value') else str(item)
        names.add(v)
    return names


def _has_code_type(manifest) -> bool:
    """是否存在代码型类型（api/command/renderer）——需要 __init__.py 入口与代码校验。"""
    code_types = {'api', 'command', 'renderer'}
    return bool(_manifest_type_names(manifest) & code_types)


def _check_assets(ext_dir: Path) -> None:
    """无代码扩展（模板/资源）的目录与清单一致性校验（代码型自动跳过）。"""
    manifest = _read_manifest(ext_dir)
    names = _manifest_type_names(manifest)
    is_template = 'template' in names
    is_resources = 'resources' in names
    if not is_template and not is_resources:
        _step('assets', '模板/资源目录', True, '非无代码扩展，跳过')
        return
    if manifest is None:
        _step('assets', '模板/资源目录', False, '清单缺失或无法解析')
        return
    if is_template and not manifest.template:
        _step('assets', '模板/资源目录', False, '清单缺少 [template] 配置')
        return
    if is_resources and not getattr(manifest, 'resources', None):
        _step('assets', '模板/资源目录', False, '清单缺少 [resources] 配置')
        return
    problems: list[str] = []
    if is_template:
        t_entry = getattr(manifest.template, 'entry', None) or 'Templates'
        target = (ext_dir / t_entry).resolve()
        if not target.is_dir():
            problems.append(f'模板目录「{t_entry}」不存在')
    if is_resources:
        root = getattr(manifest.resources, 'root', None) or 'Resources'
        target = (ext_dir / root).resolve()
        if not target.is_dir():
            problems.append(f'资源目录「{root}」不存在')
    if problems:
        _step('assets', '模板/资源目录', False, '；'.join(problems))
    else:
        _step('assets', '模板/资源目录', True, '，'.join(names))


def _check_syntax(ext_dir: Path) -> None:
    """Python 语法检查 + import 边界检查。"""
    errors: list[str] = []
    for py in ext_dir.rglob('*.py'):
        try:
            tree = ast.parse(py.read_text('utf-8'), filename=str(py))
        except SyntaxError as error:
            errors.append(f'{py.relative_to(ext_dir)}: {error.msg} (line {error.lineno})')
            continue
        for node in ast.walk(tree):
            target: str | None = None
            if isinstance(node, ast.Import):
                target = node.names[0].name
            elif isinstance(node, ast.ImportFrom) and node.module:
                target = node.module
            if target and _is_forbidden_import(target):
                errors.append(f'{py.relative_to(ext_dir)}: 禁止导入框架内部模块 {target}')
    if errors:
        _step('syntax', 'Python 语法与 import 边界', False, f'{len(errors)} 个问题', '\n'.join(errors))
    else:
        _step('syntax', 'Python 语法与 import 边界', True)


def _run_subprocess(args: list[str], cwd: Path, timeout: int = 60) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=timeout,
            env={k: v for k, v in os.environ.items()},
        )
        return proc.returncode, (proc.stdout + proc.stderr)[-4000:]
    except subprocess.TimeoutExpired:
        return -1, '执行超时'


def _check_ruff(ext_dir: Path, unibot_root: Path) -> None:
    """Ruff format check + lint（复用 UniBot venv 内的 ruff，不修改任何配置）。"""
    ruff_bin = unibot_root / '.venv' / 'bin' / 'ruff'
    if not ruff_bin.exists():
        _step('ruff', 'Ruff lint + format', True, 'ruff 未安装，跳过')
        return
    code, output = _run_subprocess([str(ruff_bin), 'check', str(ext_dir)], unibot_root)
    if code != 0:
        _step('ruff', 'Ruff lint', False, '存在 lint 错误', output)
        return
    code2, output2 = _run_subprocess([str(ruff_bin), 'format', '--check', str(ext_dir)], unibot_root)
    if code2 != 0:
        _step('ruff', 'Ruff format', False, '存在格式问题（运行 ruff format 修复）', output2)
        return
    _step('ruff', 'Ruff lint + format', True)


def _check_tests(ext_dir: Path, unibot_root: Path) -> None:
    """运行扩展自带 pytest 测试（tests/ 目录存在时）。

    在临时目录运行，避免 pytest 收集时导入含 __init__.py 的扩展包
    （扩展包入口的相对导入需要包上下文，pytest 收集阶段会报错）。
    """
    tests_dir = ext_dir / 'tests'
    if not tests_dir.exists():
        _step('tests', '扩展自带测试', True, '无 tests 目录，跳过')
        return
    import shutil
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix='unibot-studio-tests-'))
    try:
        # 复制 tests 到独立目录（无祖先包上下文）
        shutil.copytree(tests_dir, tmp / 'tests', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        # 复制扩展源码到 tmp/Extensions/<id>，供测试通过 `Extensions.<id>` 导入
        shutil.copytree(
            ext_dir, tmp / 'Extensions' / ext_dir.name,
            ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'tests'),
        )
        import os

        env = {k: v for k, v in os.environ.items()}
        env['PYTHONPATH'] = str(tmp) + os.pathsep + env.get('PYTHONPATH', '')
        code, output = _run_subprocess(
            [sys.executable, '-m', 'pytest', str(tmp / 'tests'), '-q', '--no-header', '-p', 'no:cacheprovider'],
            unibot_root,
            timeout=90,
        )
        if code != 0:
            _step('tests', '扩展自带测试', False, '测试失败', output)
        else:
            _step('tests', '扩展自带测试', True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _check_loader(ext_dir: Path, unibot_root: Path) -> None:
    """最小 Loader 绑定测试：导入入口、模拟 _bind 注入元数据、校验 id 与目录名。"""
    import tempfile
    import shutil

    framework = _framework()
    ExtensionMetadata = framework.ExtensionMetadata
    parse_manifest = framework.parse_manifest
    ManifestError = framework.ManifestError
    ExtensionConfigStore = framework.ExtensionConfigStore
    ExtensionDataStore = framework.ExtensionDataStore

    module_name = f'Extensions.{ext_dir.name}'
    sys.path.insert(0, str(unibot_root))
    tmpdir: str | None = None
    try:
        # 注册 Extensions namespace 包（正式目录可能不存在，避免依赖真实扩展目录）
        if 'Extensions' not in sys.modules:
            ns_pkg = types.ModuleType('Extensions')
            ns_pkg.__path__ = []
            sys.modules['Extensions'] = ns_pkg
        ns_pkg = sys.modules['Extensions']
        # 把草稿父目录加入 namespace 搜索路径，使 import Extensions.<id> 可解析
        parent = str(ext_dir.parent)
        if parent not in list(ns_pkg.__path__):
            ns_pkg.__path__.append(parent)
        module = importlib.import_module(module_name)
        extension = getattr(module, 'extension', None)
        if extension is None:
            _step('loader', 'Loader 绑定', False, f'入口未导出 extension 实例（{ext_dir.name}/__init__.py）')
            return
        # 模拟 Loader 的 _bind：从 Extension.toml 归一化元数据并注入
        manifest = parse_manifest((ext_dir / 'Extension.toml').read_text('utf-8'))
        metadata = ExtensionMetadata(manifest)
        tmpdir = tempfile.mkdtemp(prefix='unibot-studio-bind-')
        config_store = ExtensionConfigStore(
            Path(tmpdir), ext_dir.name,
            extension.config_model if extension.config_model is not None else extension._default_config_model(),
        )
        data_store = ExtensionDataStore(Path(tmpdir))
        extension._bind(metadata, config_store, data_store, api=types.SimpleNamespace())
        if extension.id != ext_dir.name:
            _step('loader', 'Loader 绑定', False, f'extension.id={extension.id} 与目录名 {ext_dir.name} 不一致')
            return
        _step(
            'loader', 'Loader 绑定', True,
            f'id={extension.id} commands={len(extension.commands)} services={len(extension.services)}',
        )
    except ManifestError as error:
        _step('loader', 'Loader 绑定', False, f'清单无效：{error}')
    except Exception as error:  # noqa: BLE001 - 校验脚本需捕获全部错误
        _step('loader', 'Loader 绑定', False, f'导入失败：{error}')
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
        for name in list(sys.modules):
            if name == module_name or name.startswith(f'{module_name}.'):
                sys.modules.pop(name, None)


def _check_dependencies(ext_dir: Path) -> None:
    """依赖声明检查：列出 python 依赖并确认合法。"""
    framework = _framework()
    parse_manifest = framework.parse_manifest
    ManifestError = framework.ManifestError

    manifest_path = ext_dir / 'Extension.toml'
    try:
        manifest = parse_manifest(manifest_path.read_text('utf-8'))
    except ManifestError:
        manifest = None
    if manifest is None:
        _step('dependencies', '依赖声明', False, '清单不可用，无法检查依赖')
        return
    deps = list(manifest.dependencies.python)
    ext_deps = list(manifest.dependencies.extensions)
    try:
        from packaging.requirements import Requirement

        for dep in deps:
            Requirement(dep)
    except Exception as error:  # noqa: BLE001
        _step('dependencies', '依赖声明', False, f'非法 Python 依赖：{error}')
        return
    message = 'python=' + (', '.join(deps) if deps else '无')
    if ext_deps:
        message += f'；extensions={", ".join(ext_deps)}'
    _step('dependencies', '依赖声明', True, message)


def main() -> int:
    global _UNIBOT_ROOT

    parser = argparse.ArgumentParser(description='UniBot 扩展校验（Studio 专用）')
    parser.add_argument('ext_dir', type=Path, help='待校验的扩展目录（必须位于 UniBot 根目录之外）')
    parser.add_argument('--unibot-root', type=Path, required=True, help='UniBot 根目录')
    parser.add_argument(
        '--allow-in-root', action='store_true',
        help='允许校验位于 UniBot 根目录内的扩展（仅测试工具对已部署副本使用，见 test_tools.ts）',
    )
    parser.add_argument(
        '--steps', type=str, default='',
        help='只运行指定步骤（逗号分隔，如 loader / tests；为空则全部运行）',
    )
    args = parser.parse_args()

    ext_dir = args.ext_dir.resolve()
    unibot_root = args.unibot_root.resolve()

    if not ext_dir.is_dir():
        print(json.dumps({'ok': False, 'steps': [], 'error': f'目录不存在：{ext_dir}'}, ensure_ascii=False))
        return 2
    # 路径安全：目标必须位于 UniBot 根目录之外（草稿目录）；测试工具对已部署副本
    # 显式传 --allow-in-root 放行（副本位于测试环境 Extensions/ 内，路径由后端校验）
    if not args.allow_in_root:
        try:
            ext_dir.relative_to(unibot_root)
            print(json.dumps({'ok': False, 'steps': [], 'error': '不允许校验 UniBot 目录内的扩展'}, ensure_ascii=False))
            return 2
        except ValueError:
            pass
    # 切换到 UniBot 根目录：框架配置模块按相对路径（Config.toml）解析配置，
    # 不依赖调用方 cwd（草稿工作区）
    os.chdir(unibot_root)
    # 复用 UniBot 环境：把 UniBot 根加入 sys.path 使框架包（Core.Extension /
    # 旧版 Scripts.Extensions）与其依赖可导入；同时登记根目录供布局探测使用
    sys.path.insert(0, str(unibot_root))
    _UNIBOT_ROOT = unibot_root
    # 提前初始化 NoneBot 运行时，使框架配置模块的 get_plugin_config 可用
    try:
        import nonebot

        nonebot.init()
    except Exception:  # noqa: BLE001 - 无 NoneBot 时仅跳过框架侧步骤
        pass

    # 步骤过滤器（--steps loader / tests 等，测试工具按需只跑单步）
    only_steps: set[str] = {s.strip() for s in args.steps.split(',') if s.strip()}

    def run_step(step_id: str, fn) -> None:
        if only_steps and step_id not in only_steps:
            return
        fn()

    run_step('manifest', lambda: _check_manifest(ext_dir))
    run_step('assets', lambda: _check_assets(ext_dir))
    # 无代码（模板/资源）扩展不需要代码型校验：入口缺失/无 Python 时跳过 loader/ruff/tests
    if _has_code_type(_read_manifest(ext_dir)):
        run_step('syntax', lambda: _check_syntax(ext_dir))
        run_step('ruff', lambda: _check_ruff(ext_dir, unibot_root))
        run_step('tests', lambda: _check_tests(ext_dir, unibot_root))
        run_step('loader', lambda: _check_loader(ext_dir, unibot_root))
    run_step('dependencies', lambda: _check_dependencies(ext_dir))

    ok = all(step['ok'] for step in STEPS)
    result = {'ok': ok, 'steps': STEPS, 'extension_id': ext_dir.name}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
