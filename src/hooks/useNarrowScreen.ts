import { useEffect, useState } from 'react';

/** これ未満の幅ではルール表がはみ出すので、カード表示に切り替える。 */
export const NARROW_BREAKPOINT = 720;

/** 画面が狭いかどうかを購読する。 */
export function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < NARROW_BREAKPOINT,
  );

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return narrow;
}
