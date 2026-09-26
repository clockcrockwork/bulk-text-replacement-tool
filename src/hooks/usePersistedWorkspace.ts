import { useEffect } from 'react';
import { saveWorkspace } from '../lib/storage';
import type { PersistedWorkspace } from '../types';

const SAVE_DEBOUNCE_MS = 400;

/** 入力のたびに書くと重いので、少し待ってから localStorage に保存する。 */
export function usePersistedWorkspace(workspace: PersistedWorkspace): void {
  const { inputs, groups, rules, theme } = workspace;

  useEffect(() => {
    const timer = setTimeout(
      () => saveWorkspace({ inputs, groups, rules, theme }),
      SAVE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [inputs, groups, rules, theme]);
}
