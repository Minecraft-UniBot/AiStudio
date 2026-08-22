/**
 * 会话 ↔ 草稿 双向映射 + 活跃工作区注册表（跨模块共享）。
 *
 * 生成/调试会话与审核会话都必须登记，事件服务才能按 sessionID
 * 过滤并反查草稿；草稿删除时同步清理，避免内存泄漏。
 * 工作区集合用于驱动按目录（directory）的 SSE 订阅（opencode /event
 * 必须按精确目录订阅才能收到该会话的事件）。
 */
import { draftWorkspace } from './drafts';

const SESSION_TO_DRAFT = new Map<string, string>();
const DRAFT_SESSIONS = new Map<string, Set<string>>();
/** draftId -> workspace（活跃草稿的工作区，SSE 订阅按此目录建立） */
const WORKSPACES = new Map<string, string>();

export function trackSession(draftId: string, sessionId: string | null) {
  if (!sessionId) return;
  SESSION_TO_DRAFT.set(sessionId, draftId);
  if (!DRAFT_SESSIONS.has(draftId)) DRAFT_SESSIONS.set(draftId, new Set());
  DRAFT_SESSIONS.get(draftId)!.add(sessionId);
  WORKSPACES.set(draftId, draftWorkspace(draftId));
}

export function untrackSession(draftId: string, sessionId: string | null) {
  if (!sessionId) return;
  SESSION_TO_DRAFT.delete(sessionId);
  DRAFT_SESSIONS.get(draftId)?.delete(sessionId);
}

/** 草稿删除时清理全部会话登记与工作区 */
export function untrackDraft(draftId: string) {
  const sessions = DRAFT_SESSIONS.get(draftId);
  if (sessions) {
    for (const sid of sessions) SESSION_TO_DRAFT.delete(sid);
  }
  DRAFT_SESSIONS.delete(draftId);
  WORKSPACES.delete(draftId);
}

export function getDraftSessionIds(): Map<string, Set<string>> {
  return DRAFT_SESSIONS;
}

export function draftIdForSession(sessionId: string): string | undefined {
  return SESSION_TO_DRAFT.get(sessionId);
}

/** 当前活跃的工作区集合（按目录建立 SSE 订阅） */
export function getWorkspaces(): Set<string> {
  return new Set(WORKSPACES.values());
}
