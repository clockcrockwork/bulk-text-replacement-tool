import { useEffect, useRef, useState } from 'react';
import { saveWorkspace } from '../lib/storage';
import type { PersistedWorkspace } from '../types';

const SAVE_DEBOUNCE_MS = 400;

export interface PersistedWorkspaceStatus {
  /** 直近の保存に失敗しているか。 */
  saveFailed: boolean;
  /**
   * 保留中の分も含めて、いまの内容をその場で書き出す。成否を返す。
   *
   * 画面遷移（GitHub の認可など）の直前に呼ぶ。`saveFailed` は「最後に実行済みの保存」の
   * 結果でしかなく、デバウンス中の編集はまだ書かれていない。遷移の直前に確かめないと、
   * 書けないまま離れて、戻ってきたときに古い内容へ巻き戻る。
   */
  flush: () => boolean;
}

/**
 * 入力のたびに書くと重いので、少し待ってから localStorage に保存する。
 *
 * デバウンス中にタブを閉じると保留分が消えるため、ページが隠れる／破棄される
 * タイミングで即座に書き出す。`beforeunload` はモバイル Safari で発火しないことが
 * あるので `pagehide` と `visibilitychange` を見る。
 */
export function usePersistedWorkspace(workspace: PersistedWorkspace): PersistedWorkspaceStatus {
  const { inputs, groups, rules, theme, isSample } = workspace;
  /**
   * 直近の値。イベント時に依存配列を気にせず取り出せるようにしておく。
   * レンダー中に書くと、破棄されたレンダー（Strict Mode の二重呼び出しや中断された
   * 並行レンダー）の値が残りうるので、コミット後の effect で更新する。
   */
  const latest = useRef(workspace);
  /**
   * 直近の保存に失敗しているか。
   *
   * 失敗を握り潰すと、保存されないまま編集が続き、リロードした時点でその間の
   * 作業が消える。消えるトーストではなく、直るまで出したままにできるよう
   * 状態として返す。
   */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    latest.current = { inputs, groups, rules, theme, isSample };
    const timer = setTimeout(() => {
      setFailed(!saveWorkspace({ inputs, groups, rules, theme, isSample }));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputs, groups, rules, theme, isSample]);

  /**
   * イベントハンドラから呼ぶ書き出し。このレンダーの値そのものを閉じ込めて書く。
   *
   * `latest.current` は effect（コミット後）で更新するので、「次の利用者操作より先に
   * effect が済んでいる」ことに頼ると、1つ前の内容を成功として書いて画面を離れ得る。
   * ハンドラはそれを描いたレンダーの関数なので、そのレンダーの値が利用者の見ている内容。
   */
  const flush = (): boolean => {
    const saved = saveWorkspace({ inputs, groups, rules, theme, isSample });
    setFailed(!saved);
    return saved;
  };

  useEffect(() => {
    const flushOnLeave = (): void => {
      setFailed(!saveWorkspace(latest.current));
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushOnLeave();
    };
    window.addEventListener('pagehide', flushOnLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushOnLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return { saveFailed: failed, flush };
}
