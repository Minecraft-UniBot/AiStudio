// 草稿状态机：主链 draft -> generating -> checking -> reviewing -> ready -> published
export const STATUS_LABELS = {
  draft: '草稿',
  generating: '生成中',
  checking: '校验中',
  repairing: '修复中',
  reviewing: '审核中',
  debugging: '调试中',
  ready: '可发布',
  published: '已发布',
  failed: '失败',
  error: '异常',
}

export const STATUS_COLORS = {
  draft: 'gray',
  generating: 'blue',
  checking: 'amber',
  repairing: 'amber',
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
