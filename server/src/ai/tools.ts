/**
 * 工具注册表（对应 Plan.md 7.2）：
 * 决定 AI 在生成/审核/调试阶段可使用的 OpenCode 工具；配置持久化到
 * config/tools.json，管理员可开关工具、调整默认权限与适用阶段。
 *
 * 安全：即使 OpenCode 返回 always，后端仍执行自己的路径与命令校验
 * （Plan.md 8.1），注册表只决定「是否暴露」与「默认询问策略」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../core/config';
import type { ToolEntry } from '../core/types';

const DEFAULT_TOOLS: ToolEntry[] = [
  {
    id: 'read',
    enabled: true,
    default_permission: 'allow',
    phases: ['generate'],
    note: '读取草稿文件与白名单框架文档',
  },
  {
    id: 'edit',
    enabled: true,
    default_permission: 'allow',
    phases: ['generate'],
    note: '编辑草稿文件（审核阶段禁用）',
  },
  {
    id: 'bash',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '执行命令（默认询问，后端二次校验命令与工作目录）',
  },
  {
    id: 'unibot_test_status',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：查询共享 UniBot 测试环境状态与已部署扩展',
  },
  {
    id: 'unibot_test_sync',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：同步 UniBot 测试环境到最新版本（异步）',
  },
  {
    id: 'unibot_deploy',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：把草稿扩展部署到测试环境 Extensions/（staging + 原子重命名）',
  },
  {
    id: 'unibot_undeploy',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：从测试环境移除已部署扩展',
  },
  {
    id: 'unibot_load',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：在测试环境加载扩展并报告绑定结果',
  },
  {
    id: 'unibot_logs',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：读取扩展在测试环境中的测试/加载日志',
  },
  {
    id: 'unibot_run_tests',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：在测试环境运行扩展自带 pytest 测试',
  },
  {
    id: 'unibot_validate',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '测试工具：对草稿运行与发布前一致的完整校验流水线（只读）',
  },
  {
    id: 'web_fetch',
    enabled: true,
    default_permission: 'ask',
    phases: ['generate'],
    note: '抓取网页（github.com 公开仓库只读自动放行，用于参考已有扩展；其余需人工确认）',
  },
  {
    id: 'web_search',
    enabled: false,
    default_permission: 'ask',
    phases: ['generate'],
    note: '网络搜索（默认关闭：本项目文档在本地，禁止搜索 UniBot 相关内容）',
  },
];

function toolsFile(): string {
  return join(config.data_dir, 'config', 'tools.json');
}

function loadTools(): ToolEntry[] {
  const file = toolsFile();
  if (!existsSync(file)) return structuredClone(DEFAULT_TOOLS);
  try {
    const disk = JSON.parse(readFileSync(file, 'utf-8')) as ToolEntry[];
    if (!Array.isArray(disk)) return structuredClone(DEFAULT_TOOLS);
    // 与默认表合并：保留磁盘上的开关/权限/阶段，补充新登记的默认项
    return DEFAULT_TOOLS.map((def) => {
      const saved = disk.find((t) => t.id === def.id);
      if (!saved) return def;
      return { ...def, ...saved };
    });
  } catch {
    return structuredClone(DEFAULT_TOOLS);
  }
}

function persistTools(tools: ToolEntry[]): void {
  const file = toolsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tools, null, 2) + '\n', 'utf-8');
}

let cached: ToolEntry[] | null = null;

/** 读取工具注册表（首次读取后缓存，PATCH 时失效重载） */
export function getTools(): ToolEntry[] {
  if (!cached) cached = loadTools();
  return cached.map((t) => ({ ...t }));
}

/** 更新工具注册表（按 id 合并字段，持久化到 config/tools.json） */
export function updateTools(patch: ToolEntry[]): ToolEntry[] {
  if (!Array.isArray(patch)) return getTools();
  const next = getTools().map((entry) => {
    const incoming = patch.find((p) => p.id === entry.id);
    if (!incoming) return entry;
    return {
      ...entry,
      ...incoming,
      // 白名单：阶段只允许登记过的值
      phases: (incoming.phases ?? entry.phases).filter((p) =>
        (['generate'] as string[]).includes(p),
      ) as ToolEntry['phases'],
      default_permission: ['allow', 'ask', 'reject'].includes(incoming.default_permission)
        ? incoming.default_permission
        : entry.default_permission,
    };
  });
  cached = next;
  persistTools(next);
  return next.map((t) => ({ ...t }));
}

/** 某阶段可用的工具 id 列表（审核阶段只读：edit/bash 不暴露） */
export function toolsForPhase(phase: ToolEntry['phases'][number]): string[] {
  return getTools()
    .filter((t) => t.enabled && t.phases.includes(phase))
    .map((t) => t.id);
}
