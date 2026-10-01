import type { PersistedWorkspace } from '../types';

/**
 * 描画が落ちたときに、保存データ（localStorage）に入っていない最新の作業を救うための控え。
 *
 * 復旧画面（ErrorBoundary）はアプリの外側にあり、React の状態を読めない。保存データ
 * だけを退避すると、保存に失敗している間（容量超過など）や、保存のデバウンス中・
 * 別のタブに上書きされたあとに落ちたとき、それ以降の作業を失う（issue #32）。
 *
 * 保持するのは参照だけで、正規化も複製もしない。最新の状態そのものが落ちた原因かも
 * しれず、直したり落としたりすると手で直す材料まで失う（`buildRecoveryBackup` と同じ考え方）。
 */
export interface RecoverySnapshot {
  /** 描画しようとした最新の状態を覚える。 */
  noteRendered: (workspace: PersistedWorkspace) => void;
  /** 保存データと同じ内容だと分かっている状態を覚える（起動時に読んだ値・保存に成功した値）。 */
  noteSaved: (workspace: PersistedWorkspace) => void;
  /** 保存データが別のタブに書き換えられた。どの状態も保存データと一致するとは言えない。 */
  forgetSaved: () => void;
  /** 保存データに入っていない最新の状態。最新の状態が保存済みなら null。 */
  unsaved: () => PersistedWorkspace | null;
}

/**
 * 同じ内容か。reducer は変えた部分だけ新しい配列を作るので、ふつうは参照の比較で決まる。
 * 参照が違っても中身が同じことはある（Strict Mode で初期化が2回走る、同じ値への付け替え）
 * ので、そのときだけ中身で比べる。呼ぶのは落ちたあとの復旧画面だけなので、大きな原稿を
 * 文字列にしても困らない。
 */
function sameWorkspace(a: PersistedWorkspace, b: PersistedWorkspace): boolean {
  if (
    a.inputs === b.inputs &&
    a.groups === b.groups &&
    a.rules === b.rules &&
    a.theme === b.theme &&
    a.isSample === b.isSample
  ) {
    return true;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createRecoverySnapshot(): RecoverySnapshot {
  let latest: PersistedWorkspace | null = null;
  let saved: PersistedWorkspace | null = null;
  return {
    noteRendered: (workspace) => {
      latest = workspace;
    },
    noteSaved: (workspace) => {
      saved = workspace;
    },
    forgetSaved: () => {
      saved = null;
    },
    unsaved: () => {
      if (!latest) return null;
      if (saved && sameWorkspace(latest, saved)) return null;
      return latest;
    },
  };
}
