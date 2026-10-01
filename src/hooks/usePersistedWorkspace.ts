import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRecoverySnapshot } from '../lib/recoverySnapshot';
import { isForeignWorkspaceChange, serializeWorkspace, writeWorkspace } from '../lib/storage';
import type { PersistedWorkspace } from '../types';

const SAVE_DEBOUNCE_MS = 400;

/**
 * 復旧画面（ErrorBoundary）から読む、保存データに入っていない最新の作業の控え。
 *
 * ErrorBoundary はアプリの外側にあって React の状態を読めないので、React の外に置く。
 * ページに App は1つしか無いので、モジュールに1つでよい。
 */
export const workspaceRecovery = createRecoverySnapshot();

export interface PersistedWorkspaceStatus {
  /** 直近の保存に失敗しているか。 */
  saveFailed: boolean;
  /**
   * 別のタブが作業データを書き換えたか。true の間は、このタブからは保存しない
   * （`overwrite` で解除するまで）。
   */
  conflict: boolean;
  /**
   * 保留中の分も含めて、いまの内容をその場で書き出す。成否を返す。
   *
   * 画面遷移（GitHub の認可など）の直前に呼ぶ。`saveFailed` は「最後に実行済みの保存」の
   * 結果でしかなく、デバウンス中の編集はまだ書かれていない。遷移の直前に確かめないと、
   * 書けないまま離れて、戻ってきたときに古い内容へ巻き戻る。
   * 別のタブとの食い違いがある間は書かずに false を返す（黙って上書きしない）。
   */
  flush: () => boolean;
  /**
   * 別のタブの内容を、このタブの内容で上書きして保存を再開する。成否を返す。
   * 利用者が「このタブの内容で続ける」を選んだときだけ呼ぶ。
   */
  overwrite: () => boolean;
}

/**
 * 入力のたびに書くと重いので、少し待ってから localStorage に保存する。
 *
 * デバウンス中にタブを閉じると保留分が消えるため、ページが隠れる／破棄される
 * タイミングで即座に書き出す。`beforeunload` はモバイル Safari で発火しないことが
 * あるので `pagehide` と `visibilitychange` を見る。
 *
 * 同じオリジンの複数のタブは同じキーへ保存するので、後から書いた方が前の編集を黙って
 * 消す（issue #30）。`storage` イベントで他のタブの書き込みを検知したら、このタブの
 * 保存を止めて `conflict` を返す。どちらを正とするかは利用者に選んでもらう
 * （自動で merge しない・どちらかを勝手に正にしない）。
 */
export function usePersistedWorkspace(workspace: PersistedWorkspace): PersistedWorkspaceStatus {
  const { inputs, groups, rules, theme, isSample } = workspace;

  // 復旧用の控えは**レンダー中に**更新する。描画が落ちた状態は commit されないので、
  // effect で更新すると、落ちる原因になった最新の操作が控えに入らない。破棄された
  // レンダーの値が残り得るが、救う対象としては「最後に描こうとした内容」で正しい
  // （保存に使う `latest` とは目的が違う）。
  workspaceRecovery.noteRendered({ inputs, groups, rules, theme, isSample });
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    // 起動時の状態は保存データから読んだもの（無ければ初回サンプル）。
    workspaceRecovery.noteSaved({ inputs, groups, rules, theme, isSample });
  }

  /**
   * 直近の値。離れるとき（pagehide / visibilitychange）に依存配列を気にせず取り出す。
   * レンダー中に書くと、破棄されたレンダー（Strict Mode の二重呼び出しや中断された
   * 並行レンダー）の値が残りうるので、コミット後に更新する。
   * 更新は layout effect で行う。passive effect（useEffect）は「次の利用者操作より先に
   * 済んでいる」保証が無く、編集の直後にタブを閉じると1つ前の内容を書き得るため。
   */
  const latest = useRef(workspace);
  /**
   * このタブが最後に書いた保存データの文字列。`storage` イベントで届いた値と比べ、
   * 他のタブが違う内容を書いたときだけ食い違いとする。
   *
   * 起動時は、読み込んだ状態を保存する形にしたもの。保存データの生の文字列にすると、
   * 古い版の形（キーの順・欠けた項目）で保存されていたとき、同じデータを開いた別のタブが
   * 最初の保存で今の形に書き直しただけで食い違いになる。
   */
  const [initialSerialized] = useState(() =>
    serializeWorkspace({ inputs, groups, rules, theme, isSample }),
  );
  const lastWritten = useRef<string | null>(initialSerialized);
  /**
   * 直近の保存に失敗しているか。
   *
   * 失敗を握り潰すと、保存されないまま編集が続き、リロードした時点でその間の
   * 作業が消える。消えるトーストではなく、直るまで出したままにできるよう
   * 状態として返す。
   */
  const [failed, setFailed] = useState(false);
  /**
   * 別のタブとの食い違い。ref は離れるときの保存とデバウンスの保存が読む
   * （どちらも依存配列の外から呼ばれる）。
   */
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);

  /**
   * 書き出して、成否を状態に反映する。食い違いがある間は書かない。
   * 読むのは ref と state の setter だけなので、どのレンダーで作っても振る舞いは同じ。
   */
  const save = useCallback((value: PersistedWorkspace): boolean => {
    if (conflictRef.current) return false;
    const raw = writeWorkspace(value);
    setFailed(raw === null);
    if (raw === null) return false;
    lastWritten.current = raw;
    workspaceRecovery.noteSaved(value);
    return true;
  }, []);

  useLayoutEffect(() => {
    latest.current = { inputs, groups, rules, theme, isSample };
  }, [inputs, groups, rules, theme, isSample]);

  useEffect(() => {
    const timer = setTimeout(() => {
      save({ inputs, groups, rules, theme, isSample });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [save, inputs, groups, rules, theme, isSample]);

  /**
   * イベントハンドラから呼ぶ書き出し。このレンダーの値そのものを閉じ込めて書く。
   *
   * `latest.current` は effect（コミット後）で更新するので、「次の利用者操作より先に
   * effect が済んでいる」ことに頼ると、1つ前の内容を成功として書いて画面を離れ得る。
   * ハンドラはそれを描いたレンダーの関数なので、そのレンダーの値が利用者の見ている内容。
   */
  const flush = (): boolean => save({ inputs, groups, rules, theme, isSample });

  const overwrite = (): boolean => {
    conflictRef.current = false;
    setConflict(false);
    return save({ inputs, groups, rules, theme, isSample });
  };

  useEffect(() => {
    const flushOnLeave = (): void => {
      save(latest.current);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushOnLeave();
    };
    const onStorage = (event: StorageEvent): void => {
      if (conflictRef.current) return;
      if (!isForeignWorkspaceChange(event, lastWritten.current)) return;
      conflictRef.current = true;
      setConflict(true);
      // 保存データはもうこのタブの内容ではない。落ちたときは最新の状態を救う。
      workspaceRecovery.forgetSaved();
    };
    window.addEventListener('pagehide', flushOnLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('pagehide', flushOnLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [save]);

  return { saveFailed: failed, conflict, flush, overwrite };
}
