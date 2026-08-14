"""
UniBot 扩展校验脚本（Extension Studio 专属，位于 Studio 目录内）。

由 Studio 后端以受限子进程调用：
  <unibot>/.venv/bin/python <studio>/server/validation/validate_extension.py <扩展目录> --unibot-root <unibot根目录>

约束：
- 本脚本位于 Studio 目录，不修改 UniBot 的任何文件
- 只读复用 UniBot 的 Python 工具链（venv 内的 pydantic/toml/ruff/pytest）
- 通过 sys.path 引入 Scripts.Extensions 包做清单校验与最小绑定测试
- 不调用 ExtensionManager / Loader 的完整加载流程（避免全局注册与状态污染）
- import 边界检查：拒绝扩展导入框架内部注册表（Manager/Loader/Storage 等）

输出：结构化 JSON 到 stdout（{ ok, steps, extension_id }）。
"""
from __future__ import annotations

import argparse
import ast
import importlib
import json
import subprocess
import sys
import types
from pathlib import Path

# 框架内部注册表模块（扩展禁止导入）
FORBIDDEN_IMPORTS = {
    'Scripts.Extensions.Manager',
    'Scripts.Extensions.Loader',
    'Scripts.Extensions.Storage',
    'Scripts.Extensions.Dependencies',
    'Scripts.Extensions.Market',
    'Scripts.Extensions.MarketManager',
    'Scripts.Extensions.Errors',
    'Scripts.Extensions.Base',
}

STEPS: list[dict] = []


def _step(step_id: str, name: str, ok: bool, message: str = '', detail: str = '') -> None:
    STEPS.append({'id': step_id, 'name': name, 'ok': ok, 'message': message, 'detail': detail})


def _check_manifest(ext_dir: Path) -> None:
    """清单 schema 校验 + id 与目录名一致（复用框架严格校验）。"""
    from Scripts.Extensions.Base import parse_manifest
    from Scripts.Extensions.Errors import ManifestError

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
            if target and target in FORBIDDEN_IMPORTS:
                errors.append(f'{py.relative_to(ext_dir)}: 禁止导入框架内部模块 {target}')
    if errors:
        _step('syntax', 'Python 语法与 import 边界', False, f'{len(errors)} 个问题', '\n'.join(errors))
    else:
        _step('syntax', 'Python 语法与 import 边界', True)


def _run_subprocess(args: list[str], cwd: Path, timeout: int = 60) -> tuple[int, str]:
    try:
        import os

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

    from Scripts.Extensions.Base import ExtensionMetadata, parse_manifest
    from Scripts.Extensions.Errors import ManifestError
    from Scripts.Extensions.Storage import ExtensionConfigStore, ExtensionDataStore

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
    from Scripts.Extensions.Base import parse_manifest
    from Scripts.Extensions.Errors import ManifestError

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
    parser = argparse.ArgumentParser(description='UniBot 扩展校验（Studio 专用）')
    parser.add_argument('ext_dir', type=Path, help='待校验的扩展目录（必须位于 UniBot 根目录之外）')
    parser.add_argument('--unibot-root', type=Path, required=True, help='UniBot 根目录')
    args = parser.parse_args()

    ext_dir = args.ext_dir.resolve()
    unibot_root = args.unibot_root.resolve()

    if not ext_dir.is_dir():
        print(json.dumps({'ok': False, 'steps': [], 'error': f'目录不存在：{ext_dir}'}, ensure_ascii=False))
        return 2
    # 路径安全：目标必须位于 UniBot 根目录之外（草稿目录）
    try:
        ext_dir.relative_to(unibot_root)
        print(json.dumps({'ok': False, 'steps': [], 'error': '不允许校验 UniBot 目录内的扩展'}, ensure_ascii=False))
        return 2
    except ValueError:
        pass
    # 复用 UniBot venv：把 UniBot 根加入 sys.path 使 Scripts.* 可导入
    sys.path.insert(0, str(unibot_root))
    # 提前初始化 NoneBot 运行时，使 Scripts.Config 的 get_plugin_config 可用
    try:
        import nonebot

        nonebot.init()
    except Exception:  # noqa: BLE001 - 无 NoneBot 时仅跳过框架侧步骤
        pass

    _check_manifest(ext_dir)
    _check_syntax(ext_dir)
    _check_ruff(ext_dir, unibot_root)
    _check_tests(ext_dir, unibot_root)
    _check_loader(ext_dir, unibot_root)
    _check_dependencies(ext_dir)

    ok = all(step['ok'] for step in STEPS)
    result = {'ok': ok, 'steps': STEPS, 'extension_id': ext_dir.name}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
