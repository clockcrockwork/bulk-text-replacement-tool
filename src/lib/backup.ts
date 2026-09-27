import type { PersistedWorkspace } from '../types';
import { normalizeWorkspace } from './storage';

/**
 * 作業データ（原稿・グループ・ルール）の書き出しと読み込み。
 *
 * このアプリの保存先はブラウザの localStorage だけで、次のどれでも消える。
 * - Safari の ITP は、サイトへの訪問が7日途切れるとスクリプトが書いた保存領域を消す
 * - ブラウザの「サイトデータを削除」「履歴を消去」
 * - プライベートウィンドウを閉じる
 * - 容量超過（`saveWorkspace` が false を返す状態）
 *
 * そのため、ブラウザ保存を唯一のバックアップとして扱わない。
 */

/**
 * 書き出す版。中身の形を変えたら上げる。読み込み側は未知の版を拒否する。
 *
 * 版 2 で入力に出自（`source`: GitHub から取り込んだ場所）が加わった。版 1 のアプリ
 * （凍結した V1）は版 2 を拒否する。未知のフィールドを黙って落として読み込むと、
 * 読み込めたように見えて出自だけが消えるので、拒否される方がまし。
 */
export const BACKUP_VERSION = 2;

/** 読み込める版。版 1 には出自が無いだけで、同じ正規化で読める。 */
const READABLE_VERSIONS: readonly unknown[] = [1, 2];

const BACKUP_APP = 'bulk-text-replacement-tool';

export interface BackupSummary {
  inputs: number;
  groups: number;
  rules: number;
  savedAt: string | null;
}

export type ParsedBackup =
  | { kind: 'ok'; workspace: PersistedWorkspace; summary: BackupSummary }
  | { kind: 'error'; message: string };

/** 書き出す JSON。読み返したときに何のファイルか分かるよう、種別と版を先頭に持つ。 */
export function buildBackup(workspace: PersistedWorkspace, at: Date): string {
  return JSON.stringify(
    {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      savedAt: at.toISOString(),
      workspace,
    },
    null,
    2,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 読み込んだ JSON を検証する。**この関数は現在の状態を書き換えない。**
 *
 * 取り込みが「検証 → 内容の確認 → 反映」の順になっていないと、壊れたファイルや
 * 別の版のファイルを選んだ時点で今のデータが消え、復旧手段そのものが
 * 新しいデータ消失の経路になる。
 */
export function parseBackup(text: string): ParsedBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'error', message: 'JSON として読めません。ファイルを確認してください。' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'error', message: '作業データの形式ではありません。' };
  }
  if (parsed.app !== BACKUP_APP) {
    return { kind: 'error', message: 'このツールの作業データではありません。' };
  }
  if (!READABLE_VERSIONS.includes(parsed.version)) {
    return {
      kind: 'error',
      message: `対応していない版です（このアプリが読めるのは版 ${READABLE_VERSIONS.join(' / ')}）。`,
    };
  }

  const workspace = normalizeWorkspace(parsed.workspace);
  if (!workspace) {
    return { kind: 'error', message: '中身が壊れているか、グループが1つもありません。' };
  }

  return {
    kind: 'ok',
    workspace,
    summary: {
      inputs: workspace.inputs.length,
      groups: workspace.groups.length,
      // 空行は復元しても意味が無いので、数には入れない（見た目の行数と揃える）。
      rules: workspace.rules.filter((rule) => rule.src !== '').length,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    },
  };
}
