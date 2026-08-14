# UniBot 扩展系统设计架构

> 状态：renderer/template/resources 方案设计，待实施
> 日期：2026-08-10

---

## 一、设计目标

在现有 NoneBot 插件体系之外，建立一套 **UniBot 原生扩展系统**，与 NoneBot 插件严格分离：

- **NoneBot 插件**：维持现状，通用生态插件，不能调用机器人内部方法
- **UniBot 扩展**：机器人原生扩展，可完整访问内部能力（config、managers、render、消息工具）

扩展分为三类代码型扩展与两类资源型扩展。扩展可以是单文件或多文件，但代码型扩展在运行时必须提供且只提供一个 `Extension` 实例；`template` 与 `resources` 是无代码扩展包，不导入 Python 模块、不执行生命周期钩子，也不创建 `Extension` 实例：

| 类型 | 说明 |
| ------ | ------ |
| **API 扩展** | 为其它扩展或整个系统提供特定功能服务（如天气查询、权限系统） |
| **指令扩展** | 新增指令，或继承覆盖内置指令的行为 |
| **渲染器扩展（`renderer`）** | 提供 HTML/CSS → 图片的渲染能力（如 html2pic、playwright、wkhtmltoimage），由 `RendererManager` 统一管理 |
| **模板扩展（`template`）** | 提供 Jinja2 HTML/CSS 模板，无 Python 代码；可与一个或多个 `resources` 扩展组合 |
| **资源扩展（`resources`）** | 提供图片、字体、CSS 片段等静态资源，无 Python 代码；通过 Jinja2 函数供模板读取 |

### 1.1 第一版边界

第一版只实现本地扩展运行时，不同时引入市场安装、Python 依赖自动管理、内置指令覆盖和 WebUI 动态配置。第一版稳定契约包括：

- 清单解析、版本兼容性校验、启停状态和扩展配置读取
- 扩展依赖拓扑排序和失败隔离
- API 服务注册与获取
- 新增指令的声明式注册
- 完整的单元测试和启动失败诊断

渲染器、模板和资源扩展、内置指令结构化重构、命令覆盖、WebUI 管理和市场安装按后续阶段逐步接入。代码型扩展属于与机器人同进程运行的可信代码；模板和资源包不执行代码，但仍必须限制路径穿越、符号链接和模板加载范围。市场安装必须由管理员明确确认。

---

## 二、扩展包结构

### 2.1 本地扩展（`Extensions/` 目录）

#### 单文件扩展

适合简单扩展。元数据无需额外的 `Extension.toml`，可直接通过构造参数传入
`Extension`，不需要继承：

```text
Extensions/QuickWeather.py
```

```python
from Scripts.Extensions import Extension


# 直接实例化：元数据通过构造参数声明（等价于在子类上用类属性声明）
extension = Extension(
    id='QuickWeather',
    name='简易天气',
    version='1.0.0',
    types=('api', 'command'),
    builtin=False,
)


@extension.register_command
class WeatherCommand(Command):
    ...
```

若扩展需要自定义生命周期或其它实例行为，也可以定义 `Extension` 子类并在类
属性上声明元数据后实例化。两种写法产生完全相同的运行时契约：

```python
from Scripts.Extensions import Extension


class QuickWeatherExtension(Extension):
    id = 'QuickWeather'
    name = '简易天气'
    version = '1.0.0'
    types = ('api', 'command')


extension = QuickWeatherExtension()
```

Loader 发现单文件扩展后导入模块，读取模块导出的 `extension` 实例，并校验
`extension.id` 与文件名一致。单文件扩展仍然拥有框架注入的 `config`、`data`、
logger 和生命周期方法；它不能通过直接导入内部模块绕过这些边界。

#### 多文件扩展

```text
Extensions/
└── WeatherExt/
    ├── Extension.toml      # 清单元数据（必须）
    ├── __init__.py         # 扩展入口，在此创建并导出 extension
    ├── Commands.py         # 可选：命令能力
    ├── Services.py         # 可选：服务能力
    └── ...                 # 任意内部模块
```

扩展本体统一使用 PascalCase 命名。多文件扩展的目录和 `extension.id` 必须
完全一致（含大小写），例如 `WeatherExt`、`Extensions/WeatherExt/`；
`Extension.toml` 是框架约定文件，使用 PascalCase；`__init__.py` 是唯一入口。
其它模块名不参与扩展身份校验。Loader 在所有平台上执行大小写敏感校验，避免
仅在大小写不敏感文件系统上可用。

多文件扩展直接创建 `Extension` 实例，不需要向框架工厂传入路径：

```python
from Scripts.Extensions import Extension

extension = Extension()

from . import Commands, Services  # noqa: E402,F401
```

若扩展需要自定义生命周期或其它实例行为，可以在入口中定义 `Extension` 子类并
直接实例化：

```python
from typing import override


class WeatherExtension(Extension):

    @override
    async def on_enable(self): ...


extension = WeatherExtension()
```

两种写法产生完全相同的运行时契约。Loader 导入入口后，根据已定位的扩展目录读取
并严格校验 `Extension.toml`，再把 `ExtensionMetadata`、`config`、`data`、logger
和受限服务入口注入这个实例。实例化阶段不执行全局注册或启动外部资源。多文件能力
模块若要使用装饰器，应在 `extension` 创建之后导入，并通过 `from . import extension`
获取该实例；这条导入顺序是入口契约的一部分。

### 2.2 市场扩展（GitHub Release 源码包）

**不走 PyPI**，扩展以源码形式从 GitHub Release 分发：

- 扩展注册表：一个托管在 GitHub 的 JSON 索引文件（如 `extensions.json`），收录扩展元信息：

```json
{
    "id": "WeatherExt",
  "name": "天气查询",
  "repo": "owner/unibot-weather",
  "description": "...",
  "releases": [
    { "version": "1.0.0", "asset_url": "https://github.com/owner/unibot-weather/releases/download/v1.0.0/WeatherExt.zip", "sha256": "...", "unibot_version": ">=0.0.5" }
  ]
}
```

- 安装流程：WebUI 选版本 → 下载 Release 资产 zip（复用 `Scripts/Network.py` 的 `github_download`）→ 校验注册表提供的 `sha256` → 校验 zip 根目录和 `Extension.toml` 中的 id → 解压到临时目录 → 原子替换 `Extensions/<id>/` → 重启生效
- 本地扩展与市场扩展**加载方式完全一致**（都在 `Extensions/` 目录下），Loader 无需区分来源
- 升级 = 下载新版本、完成校验后原子替换目录；卸载 = 删除目录（均在 WebUI 操作，重启生效）

市场扩展与机器人进程具有相同权限，属于可信代码，不提供进程级安全沙箱。HTTPS 和 SHA-256 只能校验传输完整性，不能证明扩展代码本身安全。安装前必须由管理员确认来源、版本和权限；后续可增加注册表签名、作者公钥和撤回列表。

安装必须是可回滚事务：下载、校验、解压和清单验证全部在临时目录完成；拒绝绝对路径、`../` 路径和符号链接，限制压缩包大小与文件数量；确认注册表 id、目录名和清单 id 一致后，才原子替换扩展目录并更新安装状态。任一步失败都不得改变当前版本。

#### 扩展的第三方 Python 依赖

扩展自身可能需要第三方库（如 playwright）。处理方式：

- `[dependencies]` 中声明 `python = ["playwright>=1.40"]`
- 安装扩展时登记依赖归属；依赖解析使用 `packaging.requirements.Requirement`，不能通过字符串截断判断包名
- 复用现有 Watchdog 机制：重启时检测依赖声明变化 → `uv sync` 自动安装；扩展依赖统一收口到独立的 `extensions` 可选组（`pyproject.toml` 的 `optional-dependencies.extensions`），由扩展系统聚合所有扩展的 `python` 依赖并写入，避免卸载扩展时误删核心或共享依赖
- 安装和升级时记录扩展版本、包来源、校验和以及 Python 依赖归属；卸载时只有在没有其它扩展使用该依赖时才移除，避免误删共享依赖
- 注册表只接受 HTTPS 的 GitHub Release URL；不允许扩展包通过 `../` 越过 `Extensions/` 目录写入文件

### 2.3 `Extension.toml` 清单格式

`Extension.toml` 只描述扩展包自身，是随源码发布的只读清单；用户配置和安装状态不写入该文件。

```toml
[manifest]
schema_version = 1               # 清单格式版本，便于后续迁移

[extension]
id = "WeatherExt"                # 唯一标识，PascalCase，必须与目录名一致
name = "示例扩展"                 # 显示名称
version = "1.0.0"
author = "xxx"
description = "扩展描述"
types = ["api"]                  # 可多选：api | command | renderer | template | resources

[compatibility]
unibot = ">=0.0.5"                # 兼容的机器人版本

[dependencies]
extensions = ["OtherExt"]        # 依赖的其他扩展 id，决定加载顺序
python = []                       # 第三方 Python 依赖，安装时登记进 pyproject.toml

[renderer]                       # 仅 renderer 扩展需要
name = "html2pic"                # 渲染器名称，必须与注册的 BaseRenderer.name 一致

[template]                       # 仅 template 扩展需要
entry = "Templates"              # 模板根目录，固定相对于扩展包根目录
resources = []                   # 可选资源扩展 id（不含组合包自身），按声明顺序组成资源查找范围

[template.config_schema.primary_color]
type = "color"                   # string | integer | number | boolean | color | select
default = "#2f80ed"
title = "主色"

[template.config_schema.compact]
type = "boolean"
default = false
title = "紧凑布局"

[template.config_schema.font]
type = "select"
default = "default"
options = ["default", "serif", "mono"]
title = "字体"

[resources]                      # 仅 resources 扩展需要
root = "Resources"               # 资源根目录，固定相对于扩展包根目录
```

- 清单由 Pydantic `ExtensionManifest` 严格校验，未知字段、非法 `types`、非法版本约束直接阻止加载；`renderer`、`template`、`resources` 专用段不能与其它类型混用
- 代码扩展的配置结构只由其 Python `config_model` 定义；无代码 template 可在 `[template.config_schema.<name>]` 中声明受限的扁平配置字段，resources 不声明业务配置
- template 配置字段名必须是合法 Python 标识符且不能以下划线开头；第一版只支持 `string`、`integer`、`number`、`boolean`、`color`、`select`，每项必须提供类型和默认值，`select` 必须提供非空 `options` 且默认值必须包含其中
- `title`、`description`、数值 `min`/`max`、字符串 `min_length`/`max_length` 为可选展示或约束字段；未知类型、未知约束、重复字段、类型不匹配和无效默认值直接阻止 template 注册
- `template`/`resources` 包不需要 `__init__.py`，Loader 直接校验包目录和声明的根目录；二者必须作为单一类型独立成包，不能与 `api`、`command`、`renderer` 混用
- 代码型扩展仍校验 `extension.id` 与目录名完全一致（含大小写），并校验依赖 id、循环依赖和 UniBot 版本范围；代码型多文件扩展入口固定为 `__init__.py`

### 2.4 独立配置与数据目录

每个扩展的配置与数据分开放置，不把扩展配置、启停状态或业务数据写进核心 `Config.toml`，也不把可变数据写进扩展源码目录：

| 数据 | 文件 | 写入者 | 内容 |
| ------ | ------ | ------ | ------ |
| 扩展清单 | `Extensions/<id>/Extension.toml` | 扩展作者 | 身份、兼容性、依赖、扩展类型 |
| 扩展启停 | `Config/Extensions.toml` | 用户 / WebUI | 每个扩展的 `enabled` 启停标志，方便用户直接编辑 |
| 代码扩展配置 | `Config/Extensions/<id>.toml` | 用户 / WebUI | 经过代码扩展 Pydantic 模型校验的业务配置 |
| template 配置 | `Config/Extensions/<template-id>.toml` | 用户 / WebUI | 经过清单 `config_schema` 生成模型校验的模板参数 |
| 管理状态 | `Data/Extension/States.toml` | ExtensionManager | 来源、版本、SHA-256、安装时间和依赖归属等运行状态，统一集中存放 |
| 业务数据 | `Data/Exs/<id>/` | 扩展的数据工具 | 缓存、数据库、生成文件等运行数据 |

```toml
# Config/Extensions.toml，用户直接编辑启停
[WeatherExt]
enabled = true
```

```toml
# Config/Extensions/WeatherExt.toml
api_key = "xxx"
city = "Shanghai"
```

```toml
# Data/Extension/States.toml，由系统维护，所有扩展状态集中存放
[WeatherExt]
source = "github_release"        # builtin | local | github_release
repository = "owner/weather-ext"
version = "1.0.0"
sha256 = "..."
installed_at = "2026-08-06T12:00:00Z"
python_dependencies = ["httpx>=0.27"]
```

- `Config.toml` 只保存 UniBot 核心配置；扩展不得直接读写它
- 扩展启停只写 `Config/Extensions.toml`（由用户或 WebUI 维护），不写进核心 `Config.toml`
- 代码扩展和声明了 `config_schema` 的 template 配置统一存放在 `Config/Extensions/<id>.toml`（与启停文件同目录，文件名即扩展 id），便于用户与 WebUI 集中管理；未声明字段的 template 和 resources 不创建配置文件
- 扩展配置使用临时文件和原子替换，配置校验或写盘失败时保留旧文件；存储读写通过实例锁串行化，避免并发读写竞争
- `Data/Exs/<id>/` 中的路径必须由框架数据工具解析；拒绝绝对路径、`..` 越界和访问其它扩展目录
- 升级或卸载源码默认同时保留 `Config/Extensions/<id>.toml` 与 `Data/Exs/<id>/`；彻底删除配置或数据必须由管理员单独确认

### 2.5 扩展禁用

扩展禁用是由管理员持久化的运行状态，不等同于扩展加载失败：

- `Config/Extensions.toml` 中 `<id>.enabled = false` 表示管理员主动禁用；缺少该字段时默认为 `true`
- 禁用状态在重启后仍然保留。Loader 读取启停标志后只解析清单和依赖关系，不导入扩展入口，不创建或绑定 `extension` 实例，也不注册命令、服务和渲染器
- 被禁用扩展的直接或间接依赖方不能启用，状态标记为 `blocked`，并记录阻塞原因；无关扩展继续正常加载
- 禁用扩展不会删除源码、配置、业务数据或安装信息；重新启用时这些内容继续使用
- 重新启用前必须先检查扩展清单、版本、依赖和 Python 依赖；检查通过后清除 `blocked` 原因，并在下一次加载时按拓扑顺序恢复
- 当前版本的 WebUI 启用/禁用操作均为重启生效。若未来提供运行时切换，禁用已运行扩展时必须先按依赖逆拓扑顺序调用已启用实例的 `on_disable()`，成功释放资源后再原子写入 `Config/Extensions.toml` 的 `enabled = false`
- `on_disable()` 只用于释放已经启动的资源；它不会删除配置或业务数据。释放失败时保留原运行状态并报告错误，不能把仍持有资源的实例伪装成已禁用

状态区分如下：`disabled` 是管理员主动禁用，`blocked` 是依赖禁用或依赖失败导致不可用，
`failed` 是本扩展自身导入、绑定或生命周期失败。三者都不应注册可用命令、服务或渲染器，
但只有 `disabled` 会持久化为管理员选择；`failed` 和 `blocked` 必须在下一次加载时重新计算。

---

## 三、框架核心（新增 `Scripts/Extensions/`）

```text
Scripts/Extensions/
├── __init__.py
├── Base.py        # Extension 基类 + 元数据解析
├── Command.py     # Command / SubCommand 类体系 + CommandManager
├── Service.py      # Service 基类 + ServiceRegistry
├── Renderer.py    # BaseRenderer、RendererRegistry、RendererManager 与渲染编排
├── Loader.py      # 扩展发现、依赖排序、导入加载
└── ...
```

### 3.1 `Base.py` — Extension 基类与统一实例

```python
class Extension:
    # 单文件扩展可提供默认类属性；Loader 以 Extension.toml 的已校验数据为准
    id: str
    name: str
    version: str
    author: str = ''
    description: str = ''
    types: tuple[str, ...] = ()
    metadata: ExtensionMetadata   # 统一归一化后的只读源数据
    config_model: type[BaseModel] | None  # 扩展配置 Pydantic Model
    config: ExtensionConfigStore  # 当前扩展独占的配置访问入口
    data: ExtensionDataStore      # 当前扩展独占的数据访问入口
    api: ServiceRegistry          # 受限的服务注册与获取入口
    logger: Logger                # 带扩展名前缀的 logger

    def register_command(self, command_cls): ...   # 实例装饰器：登记 Command 子类
    def register_service(self, service_cls): ...   # 实例装饰器：登记 Service 子类
    def register_renderer(self, renderer_cls): ... # 实例装饰器：登记 Renderer 子类
    commands: tuple[type[Command], ...]            # 当前实例登记的只读声明
    services: tuple[type[Service], ...]
    renderers: tuple[type[BaseRenderer], ...]

    def __init__(
        self,
        *,
        id: str = '',
        name: str = '',
        version: str = '',
        author: str = '',
        description: str = '',
        types: tuple[str, ...] = (),
        builtin: bool = False,
        config_model: type[BaseModel] | None = None,
    ): ...  # 创建未绑定实例，只允许登记能力类
    def _bind(self, metadata, config, data, api, logger): ... # Loader 内部一次性绑定

    async def on_load(self): ...                 # 实例创建后
    async def on_enable(self): ...               # 声明完成后启动资源
    async def on_disable(self): ...              # 释放外部资源

    def get_config_schema(self) -> dict: ...  # 返回 Pydantic JSON Schema
    def update_config(self, values: dict) -> BaseModel: ...  # 校验并持久化配置
```

元数据可直接通过构造参数声明（`Extension(id='List', name='...')`），也可在多文件
扩展中由 `Extension.toml` 归一化后由 `_bind` 注入。`commands` / `services` /
`renderers` 是**实例私有**的能力声明集合：若把它们定义为类属性，多个实例会共享
同一个 `list`，导致能力互相污染（重复注册冲突）。直接用 `Extension(...)` 创建的
多个内置扩展尤其依赖这一点，因此这三个集合必须由 `__init__` 初始化为独立实例字段。

扩展配置统一使用扩展内部声明的 Pydantic `BaseModel`：

```python
class WeatherConfig(BaseModel):
    api_key: str = Field(description='天气服务 API Key')
    city: str = Field(default='Shanghai', min_length=1)


extension = Extension(config_model=WeatherConfig)


@extension.register_service
class WeatherService(Service):
    ...


@extension.register_command
class WeatherCommand(Command):
    ...
```

`register_command()`、`register_service()` 和 `register_renderer()` 都是绑定到具体
`extension` 的实例装饰器：校验传入类的基类后，将类声明追加到该实例并原样返回，
不创建 matcher、不注册全局服务、不启动浏览器或建立网络连接。能力归属完全由装饰时
使用的实例决定，不通过扩展子类命名空间、模块扫描或方法名猜测收集。
`Extension()` 采用两阶段绑定：模块导入期间构造的是 `unbound` 实例，只允许读取
`config_model` 和使用三个注册装饰器；`metadata`、`config`、`data`、`api`、`logger`
在此阶段访问应抛出明确的 `ExtensionNotBoundError`。Loader 校验入口与清单后调用内部
`_bind()` 一次性注入这些能力并将状态切换为 `bound`；扩展代码不能直接调用 `_bind()`，
重复绑定必须失败。`on_load()` 只会在绑定完成后执行，因此生命周期方法可安全访问实例
能力。该设计不检查调用栈、不使用 `inspect` 猜测调用方，也不依赖进程级“当前扩展”
全局变量。
Loader 只读取实例上的只读声明并提交给对应 Manager。能力类可以正常继承，凡需要
覆写基类方法时，建议使用 `typing.override` 的 `@override` 装饰器作为**编码惯例
标记**（不强制，缺失不报错）。新增方法不需要标记；字段覆盖通过正常的类属性声明
即可。覆盖命令时使用明确的 `command_id`。扩展不得导入 `ExtensionManager` 或其它
内部注册表。

- Loader 为每个扩展实例注入作用域受限的 `extension.config` 和 `extension.data`；配置根目录固定为 `Config/Extensions/`（配置文件名 `Config/Extensions/<id>.toml`），数据根目录固定为 `Data/Exs/<id>/`
- `extension.config.value` 是经过校验的当前配置模型；`update(values)` 再次校验并使用 `model_dump(mode='json')` 整体原子替换 `Config/Extensions/<id>.toml`
- `ExtensionDataStore` 提供 `path(relative)`、`read_json()`、`write_json()`、`read_text()`、`write_text()` 和字节读写；所有写操作默认原子提交，所有相对路径都经过越界与保留文件检查
- 存储读写由实例锁（`threading.RLock`）串行化，避免并发读写竞争
- WebUI 通过 `model_json_schema()` 获取字段类型、默认值、描述、枚举和约束，动态生成表单
- WebUI 提交配置时再次调用 `model_validate`；校验失败返回字段级错误，不修改原配置
- 扩展业务代码通过 `extension.config.value` 读取配置、通过 `extension.config.update()` 更新配置，并通过 `extension.data` 读写数据；不得直接打开核心 `Config.toml` 或其它扩展目录
- 未声明 `config_model` 的扩展使用空配置模型，不接受未声明字段；保存时整体替换当前扩展的 `Config/Extensions/<id>.toml`，不会遗留已删除字段
- 配置校验或写盘失败时保留旧文件。包含密钥的字段只返回脱敏值，schema 用 `secret` 标记这类字段

### 3.2 `Command.py` — 类式命令注册

封装 Alconna Command 构建细节。注册 API 使用类式命令树区分元数据、参数和 handler，不要求扩展作者拼接 Alconna DSL，也不依赖 `handle_*` 方法名猜测绑定关系。命令以 `Command` / `SubCommand` 类声明，子命令通过嵌套类挂在主命令类上，`SubCommand.parent` 指向创建它的主命令实例。

```python
class Command(ABC):
    name: str = ''                 # 命令名（必填）
    description: str = ''          # 展示描述
    usage: str | None = None       # 用法说明
    aliases: tuple[str, ...] = ()  # 别名

    def __init__(self, parent=None):
        self.parent = parent       # 上层命令实例（子命令非空）
        self.arguments: list[Argument] = []
        self.subcommands: list[Command] = []
        self._discover_subcommands()   # 扫描嵌套 SubCommand 类
        self.declare()

    def declare(self): ...         # 在此调用 register_arg / register_option / register_subcommand
    def register_arg(self, name, value_type=str, *, required=True, default=UNSET,
                     description='', multi=False): ...
    def register_option(self, name, value_type=str, *, default=None,
                        description='', multi=False): ...
    def register_subcommand(self, subcommand): ...
    async def handler(self, **kwargs) -> str | None: ...      # 返回要发送的内容；None 表示不回复
    async def image_handler(self, **kwargs) -> bytes | None: ...


class SubCommand(Command):         # 空子类，用于标记嵌套子命令
    ...
```

字段职责固定：

- `name`、`description`、`usage`、`aliases` 是展示与匹配元数据
- `register_arg()` 声明一个必填/可选参数；`register_option()` 等价于 `register_arg(..., required=False)`
- `handler` 只负责绑定处理函数，主命令绑定 `$main`，子命令绑定自己的路径；处理器通过 `return` 携带要发送的内容，由框架统一 `matcher.finish()` 发送
- `value_type` 可使用 Python 类型、Alconna pattern 或框架提供的 `AtOrText` 等公共类型
- 子命令嵌套类内可用 `self.parent` 访问上层主命令实例，复用其方法

#### 主命令与子命令注册

扩展通过入口实例的 `register_command` 装饰器明确登记 `Command` 子类；框架不扫描
模块寻找命令。matcher 由 `CommandManager.build()` 在所有命令声明完成后统一创建：

```python
class BoundCommand(Command):
    name = 'bound'
    description = '管理玩家白名单绑定。'
    usage = '.bound [玩家名|子命令]'

    def declare(self):
        self.register_option('player', str, default=None, description='要绑定的玩家名')
        self.register_subcommand(List())
        self.register_subcommand(Query())
        self.register_subcommand(Remove())

    async def handler(self, player: Match[str]) -> str | None: ...
    async def bound_remove_user(self, target_user): ...

    class List(SubCommand):
        name = 'list'
        description = '列出所有绑定'
        async def handler(self) -> str | None: ...

    class Query(SubCommand):
        name = 'query'
        description = '查询指定用户的绑定'
        def declare(self):
            self.register_option('user_id', AtOrText, default=None)

    class Remove(SubCommand):
        name = 'remove'
        description = '移除指定绑定'
        def declare(self):
            self.register_arg('player', AtOrText)

        async def handler(self, player: Match[str]) -> str | None:
            ...
            return await self.parent.bound_remove_user(target)
```

- 嵌套 `SubCommand` 类在 `Command.__init__` 中自动发现并实例化，`self.parent` 指向宿主命令实例
- 同一层级的命令名、别名和参数名重复时，在 build 阶段给出包含命令 id 与字段路径的错误
- handler 必须是 async callable；签名错误、缺少 handler 或声明后未注册的分支在启动时失败，不延迟到收到消息时
- handler 参数注入与 NoneBot Alconna 一致（`Match`、`Uninfo` 等按类型注解注入）
- `.help` 从结构化声明读取主命令、参数和子命令，无需反向解析 DSL 字符串
- 每个命令使用稳定的 `command_id`，例如 `builtin:list`、`extension:WeatherExt:weather`
- 命令定义在 build 前完成完整校验；build 失败不得注册任何 matcher，避免出现半套命令

### 3.3 `Loader.py` — 发现与加载

1. 扫描 `Extensions/` 下的 `.py` 单文件和扩展目录；目录扩展读取 `Extension.toml`
2. 解析各目录扩展的 `Extension.toml`，或读取单文件扩展类属性，统一校验 id、类型、版本约束和 `[compatibility].unibot`
3. 建立依赖图并进行拓扑排序，检测缺失依赖和循环依赖
4. 导入单文件模块或多文件包的 `__init__.py`，并读取入口导出的唯一一个名为 `extension` 的未绑定实例
5. 校验实例类型及源数据与目录/文件名一致，通过内部 `_bind()` 一次性注入 metadata、`extension.config`、`extension.data`、logger 和受限服务入口；实例状态从 `discovered` 进入 `loaded`
6. 代码型扩展读取实例中由 `register_service()`、`register_command()`、`register_renderer()` 装饰器登记的类声明，实例化并提交给对应 Manager；此阶段不启动外部资源
7. `template`/`resources` 扩展不导入入口；template 校验清单 schema、编译配置模型并创建配置存储后，连同模板根目录和资源依赖一起提交；resources 只提交受校验的资源根目录
8. 按拓扑顺序执行代码型扩展的 `on_load()` 和 `on_enable()`；失败时回滚本次已启用扩展

扩展状态至少包括 `discovered`、`validated`、`loaded`、`enabled`、`failed`、`disabled`、
`blocked`。Loader 必须在导入入口前读取 `Config/Extensions.toml` 的 `enabled` 标志：主动禁用的扩展
直接进入 `disabled`，不执行导入、绑定、注册或生命周期方法。扩展失败默认不阻止机器人
启动，但该扩展及其依赖方必须标记为不可用，并向日志和 WebUI 提供简短错误原因；只有
声明为必需的核心扩展才阻止启动。关闭时按依赖图逆拓扑顺序执行 `on_disable()`，单个
扩展清理失败不能阻止其它扩展关闭。

### 3.4 `Scripts/Extensions/Manager.py` — ExtensionManager 单例

```python
@dataclass(frozen=True)
class TemplateRegistration:
    extension_id: str
    templates_dir: Path
    resource_ids: tuple[str, ...]
    config_model: type[BaseModel]
    config_store: ExtensionConfigStore


class ExtensionManager:
    registry: dict[str, Extension]       # 扩展 id → 实例
    services: dict[str, object]          # API 服务名 → 服务对象
    renderers: dict[str, BaseRenderer]   # 渲染引擎 name → 引擎实例
    templates: dict[str, TemplateRegistration]
    resources: dict[str, Path]           # resources id → 资源根目录

    def load(self): ...                  # 发现、校验、排序、声明并加载
    async def start(self): ...           # 按顺序启用，失败时回滚
    async def shutdown(self): ...        # 逆拓扑顺序释放资源
    def register_service(self, name, service): ...
    def get_service(self, name) -> object | None: ...
    def register_renderer(self, renderer: BaseRenderer): ...
    def get_renderer(self, name) -> BaseRenderer | None: ...
    def register_template(self, registration: TemplateRegistration): ...
    def register_resources(self, extension_id, resources_dir): ...
    async def render_image(self, template, size, *, context=None, renderer=None): ...
    def get_extension_info(self, id) -> dict: ...   # WebUI 展示用
    def set_enabled(self, id, enabled) -> bool: ... # 写入 Config/Extensions.toml 的 enabled，重启生效
```

`TemplateRegistration` 是框架内部记录，不是 `Extension` 实例，也不提供生命周期或代码能力。Loader 以 template id 创建作用域受限的 `ExtensionConfigStore`，动态模型的 JSON Schema 由该注册项直接提供给 WebUI；读取和更新配置时，API 根据扩展类型选择代码扩展实例的 store 或 template 注册项的 store。template 配置更新成功后，`RendererManager` 只使对应模板环境失效，不影响其它 template。

启停标志由用户或 WebUI 维护在 `Config/Extensions.toml`，管理器只更新该扩展的 `enabled`，
不读写核心 `Config.toml`：

```toml
# Config/Extensions.toml
[WeatherExt]
enabled = false        # 管理员主动禁用；重启后仍不加载
```

`Config/Extensions.toml` 中的 `enabled` 由用户或 `ExtensionManager.set_enabled()`
写入。WebUI 禁用操作必须先检查扩展 id 和依赖关系，再用临时文件原子替换该字段；
写入失败不得改变内存状态或现有文件。管理端运行状态（来源、版本、SHA-256、安装时间、
依赖归属等）统一集中存放在 `Data/Extension/States.toml`。

---

## 四、指令扩展 —— 修改内置指令

### 4.1 内置指令结构化重构

**现状**：`Plugins/Commands/*.py` 模块导入时直接创建 Alconna matcher，handler 是散落函数，无法被外部覆盖。

**重构**：每个内置命令改为声明式 `Command` / `SubCommand` 类。业务逻辑保留在类方法中，命令结构通过类属性与 `declare()` 声明，二者不混用 builder：

```python
# Plugins/Commands/List.py（重构后）
class ListCommand(Command):
    name = 'list'
    description = '查看服务器在线玩家列表。'
    usage = '.list [服务器名称]'

    def declare(self):
        self.register_option('server', str, default=None, description='服务器名称')

    async def handler(self, server: Match[str]) -> str | None: ...
    async def get_players(self, server_flag): ...     # 数据获取，可被子类复用
    async def ensure_avatars(self, player_names): ...
    def split_players(self, players): ...
    def list_handler(self, players): ...              # 文本输出
```

带子命令的内置指令（`Bound`、`About`）使用嵌套 `SubCommand` 类：

```python
# Plugins/Commands/About.py（重构后）
class AboutCommand(Command):
    name = 'about'
    description = '查看 UniBot 信息。'

    async def handler(self) -> str | None: ...

    class Check(SubCommand):
        name = 'check'
        description = '检测是否有新版本'
        async def handler(self) -> str | None: ...
```

- **模块导入时不再创建 matcher**，只声明 `Command` 类和 handler
- 由 `CommandManager.build()` 统一收集定义、应用继承覆盖并构建 Alconna Command

### 4.2 覆盖机制

指令扩展通过**类继承**覆盖内置命令：继承 `Command` 类并覆写需要修改的字段或方法。业务逻辑仍可继承内置 handler 类复用：

```python
# Extensions/MyListExt/Commands.py
from Plugins.Commands.List import ListCommand
from . import extension
from typing import override

@extension.register_command
class MyListCommand(ListCommand):
    '''只覆盖输出格式，数据获取逻辑继承不变'''
    description = '自定义列表（只显示在线）'
    usage = '.list'

    @override
    def list_handler(self, players): ...
```

- 继承后字段（`name`、`description`、`usage`、`aliases`）与 `arguments`、`subcommands` 完整保留，可精确覆写
- 覆写 `handler` / `image_handler` / 任意业务方法时建议加 `@override` 作为**编码惯例标记**（不强制，缺失不报错）
- 嵌套 `SubCommand` 同样可被继承覆盖，`self.parent` 链指向覆写后的命令实例
- 覆盖命令通过继承内置 `Command` 类，以内置 `command_id` 注册取代内置定义
- 同一 `command_id` 重复注册会报错，避免静默覆盖冲突

### 4.3 新增指令

扩展通过入口中创建的具体实例装饰 `Command` 子类，由 Loader 统一提交。
装饰后不需要在 `on_enable()` 再调用一次注册：

```python
from . import extension


@extension.register_command
class WeatherCommand(Command):
    name = 'weather'
    description = '查询天气。'
    usage = '.weather [城市]'

    def declare(self):
        self.register_option('city', str, default='Shanghai', description='要查询的城市')

    async def handler(self, city: Match[str]) -> str | None: ...
```

自动接入 `command_group_rule` 权限、`.help` 列表枚举。

---

## 五、API 扩展

### 5.1 注册服务

```python
from . import extension


@extension.register_service
class WeatherService(Service):
    name = 'weather'

    async def on_start(self): ...
    async def on_stop(self): ...
```

`Service` 与 `Command` 一样通过继承实现能力。Loader 实例化服务时注入所属
`extension`，服务通过 `self.extension.config`、`self.extension.data` 和
`self.extension.logger` 使用扩展作用域功能。

### 5.2 获取服务

```python
# 其它扩展或内置代码中，只通过 Extension 实例提供的受限服务入口
weather_service = extension.api.get('weather')
if weather_service is None:
    # 服务未注册（扩展未安装/未启用）
    ...
```

### 5.3 加载顺序保证

- `Extension.toml` 中 `[dependencies].extensions = ["WeatherExt"]` 声明依赖
- Loader 拓扑排序，被依赖方先 `on_enable()`
- 循环依赖报错并跳过相关扩展

---

## 六、渲染系统（renderer + template + resources）

### 6.1 三类扩展的职责

渲染系统拆为三个正交层次，不能再用一个 `render.kind = engine/theme` 字段混合表示：

| 类型 | 是否有 Python 代码 | 运行时职责 | 典型目录 |
| ------ | ------ | ------ | ------ |
| `renderer` | 是 | 将已经生成的 HTML/CSS 渲染为图片字节 | `Extensions/Html2Pic/` 或 `Extensions/PlaywrightRenderer/` |
| `template` | 否 | 提供 Jinja2 HTML/CSS 模板，并声明资源依赖 | `Extensions/Default/Templates/` |
| `resources` | 否 | 提供图片、字体、CSS、JSON 等只读静态文件 | `Extensions/Default/Resources/` |

`renderer` 可以独立使用；`template` 必须至少有一个模板根目录；`resources` 可以被多个模板扩展复用。`template` 与 `resources` 同属无代码类型，可以组合在同一个扩展包中（如 `Default` 同时声明 `template` + `resources`，自带资源）。它们只参与 Loader 的静态注册，不进入代码扩展生命周期，不需要 `__init__.py`，也不能声明 command/service/renderer 能力。

### 6.2 `renderer` 扩展与 `RendererManager`

#### 引擎接口（`Scripts/Extensions/Renderer.py`）

```python
class BaseRenderer:
    """渲染器扩展必须实现的 HTML/CSS 到图片接口。"""

    name: str

    async def setup(self) -> None: ...
    async def render(self, html: str, css: str) -> bytes: ...
    async def shutdown(self) -> None: ...
```

`RendererManager` 统一负责渲染器实例的发现、初始化、并发信号量、超时、默认渲染器回退和退出清理。渲染器扩展不得自行持有未由 Manager 管理的全局浏览器实例。

`RendererManager` 新增面向扩展和内置调用方的高层接口：

```python
await extension_manager.renderer_manager.render_image(
    template='List',
    size=(600, 800),
    context={'player_list': players},
    renderer='html2pic',
)
```

`render_image()` 完成「选择模板包 → 创建 Jinja 环境 → 注入模板配置与资源访问函数 → 渲染 HTML/CSS → 委托 `render()` 输出图片」的完整流程；底层 `render(html, css, name)` 只保留为已经生成 HTML/CSS 的低层接口。为避免 `RendererManager` 依赖 `Scripts.Render` 形成循环，模板加载器、资源注册表和上下文构建逻辑全部迁入 `RendererManager` 所在的 `Renderer.py` 或其同级纯内部模块，不能继续由 `Scripts.Render` 反向持有全局渲染状态。

对外提供统一入口：

```python
await extension.render_image('List', (600, 800), player_list=players)
```

`Extension.render_image()` 只做受控转发到框架注入的 `RendererManager`；未绑定、图片模式关闭、模板不存在、资源依赖未启用和渲染器不可用都必须给出明确异常或日志，不能静默返回错误图片。

### 6.3 `template` 无代码扩展包

#### template 包结构

```text
Extensions/Default/
├── Extension.toml
└── Templates/
    ├── Base.html
    ├── Base.css
    ├── List/
    │   ├── List.html
    │   └── List.css
    └── Help/
        └── Help.css
```

`Extension.toml`：

```toml
[extension]
id = "Default"
name = "默认模板"
types = ["template", "resources"]  # 可只声明 template，资源经 [template].resources 依赖其他资源包

[template]
entry = "Templates"

[resources]
root = "Resources"  # 自带资源根目录（与 template 组合时声明）

[template.config_schema.primary_color]
type = "color"
default = "#2f80ed"
title = "主色"

[template.config_schema.compact]
type = "boolean"
default = false
title = "紧凑布局"
```

模板扩展可以只提供部分文件。多个模板包按显式优先级组成 `ChoiceLoader`，当前选择的模板优先，默认模板作为最终回退。模板文件只能从扩展声明的 `entry` 目录加载，禁止通过 `..`、绝对路径或符号链接越界。

Loader 将 template 的受限 `config_schema` 编译为 Pydantic 模型，复用 `ExtensionConfigStore` 完成默认值填充、读取、校验与原子写入。该模型只描述清单允许的基础字段，不支持表达式、自定义验证器、导入路径或任意 Python 类型，确保无代码包不会获得代码执行能力。

### 6.4 `resources` 无代码扩展包

#### resources 包结构

`resources` 可以单独成包，也可以与 `template` 组合在同一扩展包中（组合时扩展同时注册模板与资源）：

```text
Extensions/Default/
├── Extension.toml
├── Templates/
│   └── ...
└── Resources/
    ├── Backgrounds/
    │   └── default.png
    ├── Fonts/
    │   └── Font.ttf
    └── Data/
        └── palette.json
```

`Extension.toml`（单独成包时只需 `[resources]` 段）：

```toml
[extension]
id = "SomeResources"
name = "示例资源"
types = ["resources"]

[resources]
root = "Resources"
```

资源扩展只注册受校验的资源根目录，不执行任何文件中的代码。资源 id 必须明确指向已注册的 `resources` 类型扩展（含组合包）；同名资源按模板声明顺序和扩展优先级解析，禁止隐式扫描任意扩展目录。

### 6.5 Jinja2 上下文契约

模板通过框架注册的 Jinja2 函数访问资源，不直接依赖本地绝对路径：

```jinja2
<img src="{{ resource_url('Default', 'Backgrounds/default.png') }}">
<style>
    {{ resource_text('Default', 'Data/palette.json') }}
</style>
```

第一版至少提供以下函数：

- `resource_path(extension_id, relative_path) -> str`：返回已校验资源文件的本地绝对路径，供 html2pic 等本地渲染器使用
- `resource_url(extension_id, relative_path) -> str`：返回渲染器可读取的 URL；若当前渲染器只支持本地文件，则由 Manager 统一转换为 `file://` URL
- `resource_text(extension_id, relative_path, encoding='Utf-8') -> str`：读取 UTF-8 文本资源，限制文件大小
- `resource_bytes(extension_id, relative_path) -> bytes`：读取二进制资源，限制文件大小

每次渲染的 Jinja 上下文注入当前 template 扩展的配置快照：

```jinja2
{{ config.primary_color }}
{{ config.compact }}
```

`config` 来自当前 template 配置模型 `model_dump(mode='json')` 的深拷贝，并包装为支持点号访问的只读对象；未声明配置时注入空对象。模板只能读取自身配置，不能指定扩展 id 读取其它扩展配置，也不能修改配置、访问配置存储对象、访问调用方 `Extension` 对象或调用任意未注册的 Python 函数。配置更新并通过校验后，Manager 必须使该 template 的 Jinja 缓存失效，下一次渲染立即读取新快照。

除 `config` 外，普通业务数据仍由调用方通过 `context`/`**kwargs` 显式传入。框架保留 `config`、`width`、`height`、`background` 和 Jinja 资源函数等名称；调用方字段不得覆盖保留名称，冲突时立即报错。

### 6.6 `Extension` 与调用方式

`Extension` 新增：

```python
async def render_image(
    self,
    template: str,
    size: tuple[int, int],
    *,
    context: dict | None = None,
    renderer: str | None = None,
) -> bytes:
    """使用当前模板配置和渲染系统生成图片。"""
```

方法内部必须要求扩展已绑定，并直接转发到 `renderer_manager.render_image(...)`。模板包由核心 `config.image.template` 选择，`template` 参数表示包内模板名称（如 `List`），不把调用扩展 id 与模板包 id 隐式绑定。Jinja 的 `config` 始终来自当前选中的 template 包，与调用方代码扩展配置无关。内置代码同样通过所属内置扩展实例调用该入口；`Scripts.Globals.render_template` 只保留迁移期兼容包装，全部调用点迁移后删除 `Scripts/Render.py`、全局 Jinja 环境和旧的 `image.theme` 语义。

### 6.7 配置与切换

`Config.toml` 只选择渲染器和模板包，不再使用 `image.theme`：

```toml
[image]
mode = true
renderer = "html2pic"
template = "Default"
```

- 模板切换只更新当前模板优先级和 Jinja Environment 缓存，支持热生效
- 渲染器切换采用重启生效；配置的渲染器不存在或加载失败时回退默认 `html2pic` 并记录警告
- 资源扩展由模板的 `resources` 显式依赖决定，资源缺失、类型错误或路径越界时模板扩展标记为 `failed`/`blocked`
- `template`、`resources` 同属无代码类型，可组合在同一扩展包中（也可各自独立），但均不能与任何代码能力混用；`renderer` 是代码型能力，第一版也要求独立成包。如需同时发布代码、模板和资源，必须拆成多个扩展包，并通过 `[dependencies].extensions` 与 `[template].resources` 显式连接

### 6.8 实施顺序与验收

1. 将 `ExtensionType.render` 拆为 `renderer`、`template`、`resources`，新增对应的 Pydantic 清单段和无代码包发现/校验流程
2. 将 `RendererManager` 扩展为模板、资源注册和 `render_image()` 的唯一编排入口，保留低层 `render()`
3. 将 `BaseRenderer`、`RendererRegistry`、`RendererManager` 与资源/模板注册模型放在 `Renderer.py` 或同级纯内部模块，移除 `Scripts.Render` 的全局环境与重复渲染逻辑
4. 新建/迁移 `Default`（template + resources 组合包），更新 `Html2Pic` 为 `renderer` 类型
5. 在 `Extension.render_image()` 和 Jinja 函数上补充单元测试，覆盖配置注入、资源路径越界、资源缺失、模板回退、renderer 回退、缓存失效和图片模式关闭
6. 更新内置命令、Globals、Config、WebUI/API、文档和市场安装校验，最后运行 `uv run ruff check .`、`compileall` 和完整 pytest

---

## 七、扩展开发体验（编辑器识别与开发工作流）

目标：扩展开发者在编辑器（VS Code / Pylance）中能把 UniBot 当作可导入的「包」，`from Scripts.Managers import ...` 有完整补全、跳转定义与类型检查。

### 7.1 运行时导入机制

- `Bot.py` 以 UniBot 根目录为工作目录运行，`Scripts`、`Plugins` 天然可导入
- Loader 用 importlib 导入 `Extensions/<id>`；扩展只允许从 `Scripts.Extensions` 导入 `Extension`、`Command`、`Service`、`BaseRenderer`、存储工具和消息公共类型，不应导入 `ExtensionManager`、核心配置单例或其它内部模块
- 扩展加载失败被 Loader 捕获并记录日志，不影响主进程启动

### 7.2 官方扩展模板（extension-template 仓库）

提供模板仓库，克隆即用：

```text
MyExtension/
├── Extension.toml
├── __init__.py          # 创建并导出唯一的 extension
├── Commands.py          # 可选，通过实例装饰器登记命令
├── Services.py          # 可选，通过实例装饰器登记服务
├── pyproject.toml       # 独立开发时使用
├── .vscode/
│   └── settings.json      # 编辑器识别配置（关键）
└── README.md
```

#### 模式 A：树内开发（推荐，零配置）

- 把扩展仓库直接 clone 到 `UniBot/Extensions/` 下（或软链接进来）
- 模板自带 `.vscode/settings.json`：

```json
{
    "python.analysis.extraPaths": ["../.."],
    "python.defaultInterpreterPath": "../../.venv/bin/python"
}
```

- `extraPaths` 指向 UniBot 根目录 → Pylance 完整识别 `Scripts` / `Plugins`，补全、跳转、类型检查全部可用
- 解释器复用 UniBot 的 `.venv`，第三方库提示也正确
- 开发时直接运行 UniBot 的 `Bot.py` 即可带上扩展调试

#### 模式 B：独立仓库开发（uv 路径依赖，可选）

- 扩展自己的 `pyproject.toml` 把 UniBot 声明为本地路径依赖：

```toml
[project]
name = "my-unibot-extension"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["minecraft-unibot"]

[build-system]
requires = ["setuptools>=75"]
build-backend = "setuptools.build_meta"

[tool.uv.sources]
minecraft-unibot = { path = "../UniBot", editable = true }
```

- UniBot 的 `pyproject.toml` 需要补充可安装配置；建议使用 setuptools：

```toml
[build-system]
requires = ["setuptools>=75"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["Scripts*", "Plugins*"]
```

- `uv sync` 后 UniBot 以 editable 方式装进扩展自己的 venv，编辑器可通过已安装包识别 `Scripts` / `Plugins`
- 若扩展还需要运行完整机器人，仍应在 UniBot 工作区启动 `Bot.py`；editable 安装主要解决补全、跳转、类型检查和独立单元测试
- 模板仓库应同时提供 `.vscode/launch.json`，默认把 `cwd` 指向 UniBot 根目录，并以 UniBot venv 启动 Bot.py

### 7.3 打包发布

- 模板提供打包脚本：把扩展目录压缩为 zip（zip 根即扩展目录，内含 `Extension.toml`）
- 开发者把 zip 上传到自己的 GitHub Release，并向扩展注册表提交收录申请
- WebUI 安装时下载解压到 `Extensions/`，与本地扩展加载方式完全一致

---

## 八、加载时序（Bot.py）

```text
main()
├── config_manager.init()
├── register_adapters(driver, ...)
├── load_plugins(NoneBot 插件)          # 现有逻辑不变
├── extension_manager.load()            # 【新增】发现、排序、加载扩展
│   ├── 导入入口 → 获取唯一 extension 实例
│   ├── 读取 extension.services → 提交服务声明
│   ├── 读取 extension.renderers → 提交 renderer 声明
│   ├── 读取 extension.commands → 提交新增指令声明
│   ├── 注册 template 的模板根目录、动态配置模型与配置存储
│   ├── 注册 resources 扩展的只读资源根目录
│   └── on_load() / on_enable() → 按拓扑顺序启动外部资源
├── command_manager.build()             # 【新增】统一构建指令 matcher
│   ├── 校验全部命令树
│   ├── 构建内置指令
│   └── 构建扩展新增指令
└── nonebot.run()
```

`command_manager.build()` 必须在全部命令声明完成后一次性提交 matcher；任一命令定义、参数、handler 或 patch 校验失败时，不得注册部分 matcher。

---

## 九、WebUI 支持

### 9.1 后端 API（`Scripts/Api/Extensions.py`）

挂载于 `/webui/api/extensions`：

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| GET | `/api/extensions` | 已安装扩展列表（类型/版本/依赖/启停状态） |
| GET | `/api/extensions/items/{id}` | 扩展详情 + 配置 schema |
| POST | `/api/extensions/{id}/enable` | 持久化启用意图（依赖满足后重启生效） |
| POST | `/api/extensions/{id}/disable` | 持久化禁用意图（重启生效，不删除数据） |
| GET | `/api/extensions/{id}/config` | 读取扩展配置 |
| PATCH | `/api/extensions/{id}/config` | 更新扩展配置 |
| DELETE | `/api/extensions/{id}` | 卸载市场扩展 |
| GET | `/api/extensions/renderers` | 可用渲染引擎列表（含当前选中） |
| POST | `/api/extensions/renderers/switch` | 切换渲染引擎 |
| GET | `/api/extensions/templates` | 可用模板扩展列表 |
| POST | `/api/extensions/templates/switch` | 切换模板扩展并立即使 Jinja2 缓存失效 |
| GET | `/api/extensions/resources` | 可用资源扩展及资源状态 |

- 修改配置、启停、卸载、安装以及切换 renderer 或 template 都要求 WebUI 管理员权限；列表和详情接口至少要求已认证用户
- 通用配置接口支持代码扩展和 template：代码扩展从实例 `config_model`/store 取值，template 从 `TemplateRegistration.config_model`/`config_store` 取值；resources 返回“不支持配置”而不是创建空配置文件
- 启用接口在依赖仍被禁用、缺失或版本不兼容时拒绝写入，并返回阻塞依赖及原因；禁用接口成功后，其依赖方在下一次加载时显示为 `blocked`
- API 响应不得返回配置密钥、内部路径或完整 traceback；密钥字段只返回“已配置”状态，诊断信息使用可公开的错误编号和简短原因
- `/renderers`、`/templates`、`/resources` 等静态路径必须在参数路由前注册；详情使用 `/items/{id}`，避免扩展 id 吞掉静态路径

### 9.2 前端页面（`WebUi/src/views/ExtensionsView.vue`）

- Tabs：已安装扩展 / 扩展市场
- 扩展卡片：名称、类型徽标（API/指令/renderer/template/resources）、版本、作者、启停开关、配置按钮
- 配置弹窗：代码扩展使用 `config_model` 导出的 JSON Schema；template 使用清单 `config_schema` 编译出的 JSON Schema；resources 不显示配置入口（复用 ConfigView 模式）
- 渲染设置：分别选择当前 renderer 与 template；resources 卡片显示依赖关系和资源状态

配套文件：

- `WebUi/src/stores/extension.js`
- `WebUi/src/router/index.js` 新增路由
- `WebUi/src/components/layout/Sidebar.vue` 新增侧边栏入口

---

## 十、实施阶段

| 阶段 | 内容 | 依赖 |
| ------ | ------ | ------ |
| **A0 契约与失败测试** | 状态机、错误模型、生命周期回滚、服务/命令冲突测试 | — |
| **A1 本地运行时** | `Scripts/Extensions/`（Base/Command/Loader）+ `ExtensionManager` + 清单校验、拓扑排序、启停状态 | A0 |
| **A2 配置、数据与 API 服务** | `ExtensionConfigStore` + `ExtensionDataStore` + 独立配置/数据目录 + 服务注册/获取 + 依赖失败传播 | A1 |
| **A3 新增指令** | `Command` / `SubCommand` 类 + `CommandManager`，只支持新增指令和统一权限注入 | A1 |
| **A4 渲染系统** | `BaseRenderer`、`RendererManager`、renderer/template/resources 注册、Jinja2 上下文和内置 html2pic 适配 | A2 |
| **A5 内置指令重构** | 8 个内置指令改用 `Command` 类声明，保持现有行为和插件兼容性 | A3 |
| **A6 指令覆盖** | 类继承覆盖：继承内置 `Command` 类覆写字段/方法，按 `command_id` 注册取代 | A5 |
| **A7 WebUI** | 扩展列表、详情、配置和启停接口，再接入前端页面 | A2–A4 |
| **A8 市场与依赖** | GitHub Release 注册表、安全解压、安装事务、回滚、依赖归属和 Watchdog 联动 | A1–A2 |
| **A9 示例与文档** | API、命令、渲染示例扩展和开发文档 | A3–A4 |

---

## 十一、涉及文件清单

### 新增

| 文件 | 说明 |
| ------ | ------ |
| `Scripts/Extensions/__init__.py` | 框架包导出 |
| `Scripts/Extensions/Base.py` | Extension 基类 + 元数据 |
| `Scripts/Extensions/Storage.py` | 每扩展独立的配置与数据工具 |
| `Scripts/Extensions/Command.py` | 结构化命令定义、`Command`/`SubCommand` 类与 `CommandManager` |
| `Scripts/Extensions/Service.py` | `Service` 基类与受限 `ServiceRegistry` |
| `Scripts/Extensions/Renderer.py` | BaseRenderer、RendererRegistry、RendererManager、模板与资源编排 |
| `Extensions/Html2Pic/` | 内置 html2pic renderer 扩展（默认/回退） |
| `Extensions/Default/` | 无代码默认 template + resources 组合扩展 |
| `Scripts/Extensions/Loader.py` | 发现/排序/加载 |
| `Extensions/README.md` | 本地扩展开发与目录约定 |
| `extension-template/`（独立模板仓库） | 扩展开发模板、调试配置与打包脚本 |
| `Scripts/Extensions/Manager.py` | ExtensionManager 单例 |
| `Scripts/Extensions/MarketManager.py` | 扩展市场管理器单例 |
| `Scripts/Extensions/Builtin/` | 内置命令扩展目录 |
| `Scripts/Api/Extensions.py` | WebUI REST 路由 |
| `Extensions/` | 扩展目录（含示例扩展） |
| `WebUi/src/views/ExtensionsView.vue` | 扩展管理页面 |
| `WebUi/src/stores/extension.js` | Pinia store |

### 修改

| 文件 | 改动 |
| ------ | ------ |
| `Bot.py` | 加载时序：extension_manager.load() + command_manager.build() |
| `Plugins/Commands/*.py`（8 个） | handler 与命令定义分离，导入时不建 matcher |
| `Plugins/Commands/Help.py` | `get_enabled_commands()` 适配新枚举方式 |
| `Scripts/Render.py` | 迁移期兼容包装；最终由 RendererManager 统一完成模板加载和图片渲染 |
| `Scripts/Config.py` | `ImageConfig` 使用 `renderer`、`template` 字段，删除 `theme` 字段 |
| `Watchdog.py` | 追踪扩展 Python 依赖，重启前调用 uv sync |
| `Scripts/Globals.py` | 可能调整 render_template 获取方式 |
| `Scripts/Managers/__init__.py` | 导出 extension_manager |
| `Scripts/Api/__init__.py` | 挂载 extensions_router |
| `WebUi/src/router/index.js` | 新增 /extensions 路由 |
| `WebUi/src/components/layout/Sidebar.vue` | 新增侧边栏入口 |

---

## 十二、验证方案

1. **编译检查**：`python -m compileall Scripts Plugins Extensions` + IDE 诊断全绿
2. **API 扩展验证**：示例 API 扩展注册服务 → 指令扩展调用该服务成功
3. **新指令验证**：扩展用 `@extension.register_command` 声明的指令经 Loader 提交后出现在 `.help` 列表，权限规则生效
4. **命令树验证**：主命令参数与子命令参数互不污染；重复名称、别名和参数名在 build 阶段报告字段路径
5. **指令覆盖验证**：示例扩展继承内置 `Command` 类，覆写字段/方法（可用 `@override` 标注），并通过同名 `command_id` 注册取代；其它字段和行为不变
6. **模板验证**：切换 template 后 `.list` 出图样式变化，缺失模板文件回退默认 template
7. **renderer 验证**：切换 renderer 后配置写入成功并提示重启；重启后出图正常；配置不存在的 renderer 时回退内置 html2pic 并告警
8. **资源验证**：template 可通过 Jinja2 资源函数读取声明依赖的 resources；资源缺失、越界和未声明访问均被拒绝
9. **禁用验证**：WebUI 禁用扩展 → 原子写入 `Config/Extensions.toml` → 重启；确认代码入口未导入、无生命周期调用，template/resources 未注册，命令/服务/renderer 均未注册，配置和数据保留；依赖方进入 `blocked`
10. **启用验证**：WebUI 启用扩展 → 检查依赖和 Python 依赖 → 重启；确认按拓扑顺序恢复并清除旧的 `blocked` 原因
11. **依赖验证**：拓扑排序正确，循环依赖报错不崩溃；template 对 resources 的依赖先注册
12. **配置验证**：代码扩展的 Pydantic 模型与 template 的受限清单 schema 均能生成 WebUI schema；template 默认值、类型、选项和约束生效；非法配置返回字段级错误且保留旧值；resources 不创建配置文件
13. **模板配置上下文验证**：Jinja 可通过 `config.xxx` 读取当前 template 的只读配置快照；未声明字段不可写入或访问；模板不能读取其它扩展配置，业务 context 不能覆盖 `config` 等保留名称；配置更新后下一次渲染立即生效
14. **命令字段验证**：缺少 handler、重复名称/别名、非法默认值和非 async handler 均在 build 阶段给出字段路径明确的错误
15. **覆盖验证**：扩展继承内置命令类并覆写字段/方法后，覆盖生效且未覆写部分保持不变（`@override` 为惯例标记，不强制）
16. **切换验证**：切换 template 无需重启即可影响下一次出图；切换 renderer 在重启前不影响当前实例，重启后使用新 renderer
17. **失败隔离验证**：代码扩展导入、`on_load()` 或 `on_enable()` 失败时记录状态和简短原因，已启动扩展按逆拓扑顺序回滚，其他无关扩展仍可运行
18. **独立存储验证**：每个代码扩展只读写自己的 `Config/Extensions/<id>.toml` 和 `Data/Exs/<id>/`；绝对路径、`..` 越界、访问其它扩展目录和覆盖框架状态文件均被拒绝
19. **配置回滚验证**：配置校验失败、并发写入或原子替换失败时，旧配置和其他扩展配置均保持不变
20. **命名验证**：代码扩展 id 与目录大小写不一致、入口未导出唯一 `extension` 实例时拒绝加载；template/resources 根目录不存在、越界或包含符号链接时拒绝启用
21. **安装事务验证**：SHA-256 不匹配、清单不一致、路径穿越、符号链接、超出文件限制或依赖同步失败时，当前扩展版本不发生改变

---

## 十三、已确认决策

1. **扩展配置 schema**：代码扩展使用内部声明的 Pydantic Model；template 使用清单 `[template.config_schema.<name>]` 声明受限扁平字段，Loader 将其编译为 Pydantic Model；两者均生成 WebUI schema，并在读取和更新时执行校验。resources 不声明业务配置，Jinja 通过只读 `config.xxx` 读取当前 template 配置。
2. **指令覆盖粒度**：第一版只支持新增指令；后续通过继承内置 `Command` 类覆写字段或方法，按 `command_id` 注册取代。覆写方法时建议用 `@override` 标注（编码惯例，不强制）；业务 handler 类可继承复用，未覆写的行为保持原样。
3. **渲染引擎接口**：统一使用 `render(html, css) -> bytes`，暂不额外支持传入完整 HTML 文档的接口。
4. **切换生效方式**：template 切换热生效；renderer 切换写入配置并在重启后生效；resources 由 template 的显式依赖决定。
5. **能力注册方式**：扩展入口先创建唯一 `extension` 实例，再用 `@extension.register_command`、`@extension.register_service` 和 `@extension.register_renderer` 把对应能力类登记到该实例。装饰器只记录声明；Loader 负责实例化并提交 Manager，`CommandManager.build()` 负责统一校验和提交 matcher。
6. **扩展数据边界**：每个代码扩展使用独立的 `Config/Extensions/<id>.toml` 和 `Data/Exs/<id>/`；声明配置的 template 只使用 `Config/Extensions/<id>.toml`，不分配数据目录；resources 不分配业务配置或数据目录。所有扩展包的启停标志由用户维护在 `Config/Extensions.toml`，管理端运行状态统一存放在 `Data/Extension/States.toml`，二者均仅由框架维护。框架只向代码扩展注入作用域受限的配置与数据工具，扩展不得写入核心 `Config.toml`、框架状态文件或其它扩展目录。
7. **扩展命名规范**：代码型多文件扩展的 id 与目录统一使用完全一致的 PascalCase，入口固定为 `__init__.py`；template/resources 无入口文件，分别通过清单声明 `entry`/`root`，目录内相对路径必须经过大小写、越界和符号链接校验。
8. **无代码扩展约束**：template/resources 不创建 `Extension` 实例、不执行 Python 生命周期、不注册代码能力；template 可声明受限配置并通过 Jinja `config.xxx` 读取自身配置，通过资源函数读取清单声明依赖的 resources；resources 没有业务配置。
9. **统一实例契约**：单文件模块和多文件代码包的入口都必须导出一个名为 `extension` 的 `Extension` 实例，且不得再导出第二个扩展实例。直接实例化 `Extension` 与继承 `Extension` 后实例化是等价创建方式；扩展入口不需要传入 `__file__` 或其它路径参数。实例在导入期间只负责登记能力，Loader 绑定后才开放 metadata、config、data、logger 和服务入口。
