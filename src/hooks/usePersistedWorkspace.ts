import { useEffect, useRef, useState } from 'react';
import { saveWorkspace } from '../lib/storage';
import type { PersistedWorkspace } from '../types';

const SAVE_DEBOUNCE_MS = 400;

/**
 * 入力のたびに書くと重いので、少し待ってから localStorage に保存する。
 *
 * デバウンス中にタブを閉じると保留分が消えるため、ページが隠れる／破棄される
 * タイミングで即座に書き出す。`beforeunload` はモバイル Safari で発火しないことが
 * あるので `pagehide` と `visibilitychange` を見る。
 */
export function usePersistedWorkspace(workspace: PersistedWorkspace): boolean {
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

  useEffect(() => {
    const flush = (): void => {
      setFailed(!saveWorkspace(latest.current));
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return failed;
}
