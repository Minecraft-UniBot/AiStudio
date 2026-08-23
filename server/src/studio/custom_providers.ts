/**
 * 自定义 OpenAI 兼容模型提供商（NewApi / one-api / 各家中转等）。
 *
 * - 注册表持久化在 <data_dir>/config/custom_providers.json（含 API Key，仅落盘本机，
 *   绝不回传前端；对应 AGENT.md「不做浏览器保存模型密钥」的边界——密钥只存在服务端）
 * - 同时把 provider 定义写入 opencode 隔离配置 opencode.jsonc
 *   （npm: @ai-sdk/openai-compatible + options.baseURL/apiKey），重启 opencode 后生效
 * - 平台模型选择器只展示：opencode Zen 免费网关（内置）+ 这里添加的自定义提供商；
 *   其余 provider 一律过滤（见 index.ts selectableProviders）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { opencode } from '../opencode/gateway';

/** 内置唯一保留的 provider id：OpenCode Zen 免费/共享模型网关 */
export const BUILTIN_PROVIDER_ID = 'opencode';

export interface CustomProviderModel {
  id: string;
  label: string;
}

export interface CustomProvider {
  /** opencode provider id（由名称生成的 slug，如 ls_api） */
  id: string;
  name: string;
  /** OpenAI 兼容接口根地址（通常以 /v1 结尾） */
  base_url: string;
  /** 仅存本地注册表与 opencode 配置，不回传前端 */
  api_key: string;
  models: CustomProviderModel[];
  created_at: string;
}

/** 前端可见形态（脱敏后） */
export type PublicCustomProvider = Omit<CustomProvider, 'api_key'>;

export class CustomProviderError extends Error {
  constructor(
    message: string,
    public code: string = 'CUSTOM_PROVIDER_ERROR',
  ) {
    super(message);
  }
}

function registryPath(): string {
  return join(config.data_dir, 'config', 'custom_providers.json');
}

function readRegistry(): CustomProvider[] {
  const file = registryPath();
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as CustomProvider[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logger.warn('providers', '自定义提供商注册表解析失败，视为空列表', {
      file,
      error: (e as Error).message,
    });
    return [];
  }
}

function writeRegistry(list: CustomProvider[]): void {
  const file = registryPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

export function listCustomProviders(): CustomProvider[] {
  return readRegistry();
}

/** 当前已注册的自定义 provider id 集合（options 过滤与切换校验共用） */
export function customProviderIds(): Set<string> {
  return new Set(readRegistry().map((p) => p.id));
}

/** 该 provider id 是否允许出现在平台模型选择器中（Zen 网关或自定义） */
export function isSelectableProvider(id: string): boolean {
  return id === BUILTIN_PROVIDER_ID || customProviderIds().has(id);
}

export function maskCustomProvider(provider: CustomProvider): PublicCustomProvider {
  const { api_key: _drop, ...rest } = provider;
  return rest;
}

/** 名称转 slug id；非 ASCII（中文等）回退 custom_provider，冲突追加序号 */
function slugifyId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'custom_provider';
  const taken = new Set([BUILTIN_PROVIDER_ID, ...readRegistry().map((p) => p.id)]);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

/** 规范化 API 地址：补协议、去尾部斜杠（/v1 由用户按网关要求填写） */
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** 从 OpenAI 兼容接口拉取模型列表（GET {base}/models，NewApi 等均支持） */
async function fetchModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CustomProviderError(`无法连接 ${baseUrl}：${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new CustomProviderError(
      `获取模型列表失败（HTTP ${res.status}），请检查 API 地址与密钥，或改用手动填写`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
  if (ids.length === 0) {
    throw new CustomProviderError('接口未返回任何模型，请检查密钥权限或改用手动填写模型列表');
  }
  return [...new Set(ids)];
}

export async function addCustomProvider(input: {
  name?: string;
  base_url?: string;
  api_key?: string;
  /** 可选手动指定模型 ID 列表；缺省时自动请求 {base_url}/models 获取 */
  models?: string[];
}): Promise<PublicCustomProvider> {
  const name = input.name?.trim() ?? '';
  const apiKey = input.api_key?.trim() ?? '';
  if (!name) throw new CustomProviderError('请填写提供商名称');
  if (!apiKey) throw new CustomProviderError('请填写 API Key');
  if (!input.base_url?.trim()) throw new CustomProviderError('请填写 API 地址');
  const baseUrl = normalizeBaseUrl(input.base_url);

  const manual = (input.models ?? []).map((m) => String(m).trim()).filter(Boolean);
  const modelIds = manual.length > 0 ? [...new Set(manual)] : await fetchModelIds(baseUrl, apiKey);

  const list = readRegistry();
  if (list.some((p) => p.name === name)) {
    throw new CustomProviderError(`提供商「${name}」已存在`, 'NAME_CONFLICT');
  }
  const provider: CustomProvider = {
    id: slugifyId(name),
    name,
    base_url: baseUrl,
    api_key: apiKey,
    models: modelIds.map((id) => ({ id, label: id })),
    created_at: new Date().toISOString(),
  };

  // 先写注册表再写 opencode 配置；配置写入失败时回滚注册表，保证两边一致
  writeRegistry([...list, provider]);
  try {
    opencode.upsertProvider(provider.id, {
      npm: '@ai-sdk/openai-compatible',
      name: provider.name,
      options: { baseURL: provider.base_url, apiKey: provider.api_key },
      models: Object.fromEntries(provider.models.map((m) => [m.id, {}])),
    });
  } catch (e) {
    writeRegistry(list);
    throw new CustomProviderError(`写入 OpenCode 配置失败：${(e as Error).message}`);
  }
  logger.info('providers', '已添加自定义 OpenAI 兼容提供商', {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    models: provider.models.length,
  });
  return maskCustomProvider(provider);
}

export function removeCustomProvider(id: string): void {
  const list = readRegistry();
  const target = list.find((p) => p.id === id);
  if (!target) throw new CustomProviderError('自定义提供商不存在', 'NOT_FOUND');
  writeRegistry(list.filter((p) => p.id !== id));
  try {
    opencode.removeProvider(id);
  } catch (e) {
    // 注册表已删即视为删除成功：配置残留只是多余条目，不影响平台行为
    logger.warn('providers', '清理 OpenCode 配置中的自定义提供商失败', {
      id,
      error: (e as Error).message,
    });
  }
  logger.info('providers', '已删除自定义提供商', { id, name: target.name });
}
