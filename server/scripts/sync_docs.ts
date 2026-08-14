/**
 * 同步 UniBot 权威文档到 Studio 内置文档副本（prompts/docs/）。
 *
 * 用法：cd Studio/server && bun run scripts/sync_docs.ts
 * 覆盖复制，不删除目标目录中多余文件。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCS_DEST = join(import.meta.dir, '..', 'prompts', 'docs');

const SOURCES: Array<[string, string]> = [
  ['UniBot/Docs/docs/unibot/开发插件.md', '开发插件.md'],
  ['UniBot/Docs/docs/unibot/扩展系统.md', '扩展系统.md'],
  ['UniBot/Docs/docs/unibot/配置说明.md', '配置说明.md'],
  ['UniBot/Docs/docs/unibot/上传市场.md', '上传市场.md'],
  ['UniBot/Docs/docs/unibot/接口文档.md', '接口文档.md'],
  ['UniBot/AGENT.md', '编码规范.md'],
];

mkdirSync(DOCS_DEST, { recursive: true });

let count = 0;
for (const [src, dest] of SOURCES) {
  const from = join(REPO_ROOT, src);
  const to = join(DOCS_DEST, dest);
  copyFileSync(from, to);
  console.log(`✓ ${src} -> prompts/docs/${dest}`);
  count += 1;
}
console.log(`\n同步完成：${count} 个文件已复制到 ${DOCS_DEST}`);
