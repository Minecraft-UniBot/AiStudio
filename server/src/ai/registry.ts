/**
 * 功能模块注册表（对应 Plan.md 7.4）：
 * 平台功能按模块注册，每个模块可独立启用/停用；前端根据开关隐藏入口与 Tab，
 * 后端拒绝未启用模块的 API。新增功能 = 新增模块目录 + 注册表登记 + 一个开关。
 */
import { config } from '../core/config';

export interface FeatureModule {
  id: keyof typeof config.features;
  name: string;
  description: string;
  /** 是否已实现（未实现的模块只读展示） */
  implemented: boolean;
}

const MODULES: FeatureModule[] = [
  {
    id: 'test_tools',
    name: '测试工具（OpenCode 插件）',
    description: '生成会话内通过插件部署/加载/测试扩展到共享测试环境',
    implemented: true,
  },
  {
    id: 'mc_test_environment',
    name: 'MC 测试环境',
    description: '备用方案：绑定测试服或自动克隆测试服（暂未实现）',
    implemented: false,
  },
  {
    id: 'market_publish',
    name: '市场发布',
    description: '从校验通过的草稿生成 Release zip 与市场元数据（暂未实现）',
    implemented: false,
  },
  {
    id: 'git_integration',
    name: 'Git / PR 工作流',
    description: 'GitHub 仓库创建与 PR 工作流，始终保持人工确认（暂未实现）',
    implemented: false,
  },
];

/** 模块列表（含当前开关状态） */
export function listModules(): Array<FeatureModule & { enabled: boolean }> {
  return MODULES.map((m) => ({ ...m, enabled: config.features[m.id] === true }));
}

/** 查询模块是否启用；未注册的模块视为关闭 */
export function isFeatureEnabled(id: string): boolean {
  return (config.features as Record<string, boolean>)[id] === true;
}

/** 后端拒绝未启用模块的 API（守卫） */
export function assertFeatureEnabled(id: string): void {
  if (!isFeatureEnabled(id)) {
    const err = new Error(`功能模块「${id}」未启用`) as Error & { status?: number };
    err.status = 403;
    throw err;
  }
}
