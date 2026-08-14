// 草稿状态机：三阶段主链 draft -> planning -> coding -> reviewing -> ready -> published
export const STATUS_LABELS = {
  draft: '草稿',
  planning: '规划中',
  coding: '编码中',
  reviewing: '审查中',
  debugging: '修复中',
  ready: '可发布',
  published: '已发布',
  failed: '失败',
  error: '异常',
}

export const STATUS_COLORS = {
  draft: 'gray',
  planning: 'blue',
  coding: 'blue',
  reviewing: 'purple',
  debugging: 'purple',
  ready: 'green',
  published: 'green',
  failed: 'red',
  error: 'red',
}

export const TYPE_LABELS = {
  api: 'API 扩展',
  command: '指令扩展',
  renderer: '渲染器',
  template: '模板',
  resources: '资源',
}
