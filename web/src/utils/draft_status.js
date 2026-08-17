// 草稿状态机：draft -> planning -> coding -> ready -> published（编码阶段 AI 用测试工具自测）
export const STATUS_LABELS = {
  draft: '草稿',
  planning: '规划中',
  coding: '编码中',
  ready: '可发布',
  published: '已发布',
  error: '异常',
}

export const STATUS_COLORS = {
  draft: 'gray',
  planning: 'blue',
  coding: 'blue',
  ready: 'green',
  published: 'green',
  error: 'red',
}

export const TYPE_LABELS = {
  api: 'API 扩展',
  command: '指令扩展',
  renderer: '渲染器',
  template: '模板',
  resources: '资源',
}
