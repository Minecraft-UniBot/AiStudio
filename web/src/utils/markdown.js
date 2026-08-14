/**
 * Markdown 渲染（Plan.md 9.5.9：AI 文本与摘要统一经 markdown 渲染）
 * 使用 markdown-it：
 *   - html: false 禁止原始 HTML，防 XSS
 *   - linkify: true 自动把裸 URL 变成链接
 *   - breaks: true 换行转为 <br>，聊天场景阅读更自然
 * 代码高亮暂用统一 CSS 样式（styles 中 .markdown-body），后续可按需接入 highlight.js
 */
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
})

/** 渲染 markdown 文本为 HTML；非字符串输入安全兜底为空字符串 */
export function render_markdown(text) {
  return md.render(String(text ?? ''))
}
