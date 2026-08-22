/**
 * 源码根锚点（server/src）。
 *
 * 资源定位约定（prompts / skills / validation / plugins 均位于 src 的上一级）：
 * - 开发模式：resSrcDir() 回退到本文件的 import.meta.dir（即 server/src）
 * - 单文件可执行版：启动器把内置资源解压到 <数据目录>/resources/server/src，
 *   并通过 UNIBOT_STUDIO_RES_DIR 注入该路径
 *
 * 为什么单独建这个文件：config.ts 已移入 core/ 子目录，import.meta.dir 不再是
 * src 根；所有「以 src 根为基准」的路径解析统一引用此处的 srcRootDir()，
 * 与目录结构调整解耦。
 */

/** server/src 绝对路径（本文件所在目录，保持位于 src 根，勿移动） */
export function srcRootDir(): string {
  return import.meta.dir;
}
