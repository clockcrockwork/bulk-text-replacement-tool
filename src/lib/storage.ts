import type { Group, InputText, PersistedWorkspace, Rule, Theme } from '../types';

/** 永続化キー。スキーマを壊す変更をしたら末尾の版を上げること。 */
export const STORAGE_KEY = 'bt-bulk-replace-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * localStorage の内容を検証して読み込む。
 * 壊れていたり形が違えば null を返し、呼び出し側が初期値にフォールバックする。
 */
export function loadWorkspace(): PersistedWorkspace | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // プライベートモードなどで localStorage が使えない。
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const groups = Array.isArray(parsed.groups) ? (parsed.groups as Group[]) : [];
  if (groups.length === 0) return null; // グループが無い状態は復元しても使えない。

  return {
    inputs: Array.isArray(parsed.inputs) ? (parsed.inputs as InputText[]) : [],
    groups,
    rules: Array.isArray(parsed.rules) ? (parsed.rules as Rule[]) : [],
    theme: parsed.theme === 'dark' ? 'dark' : 'light',
  };
}

export function saveWorkspace(workspace: PersistedWorkspace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    // 容量超過などは黙って諦める（入力を失わせないことを優先）。
  }
}

/** OS のダークモード設定を初期テーマとして使う。 */
export function preferredTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
