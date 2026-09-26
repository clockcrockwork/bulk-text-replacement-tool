import { useEffect } from 'react';

/**
 * 全画面オーバーレイの裏側がスクロールしないように body を固定する。
 * iOS Safari 対策で `position: fixed` を使うため、解除時にスクロール位置を復元する。
 */
export function useScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;

    const scrollY = window.scrollY;
    const bodyStyle = document.body.style.cssText;
    const htmlOverflow = document.documentElement.style.overflow;

    document.documentElement.style.overflow = 'hidden';
    Object.assign(document.body.style, {
      position: 'fixed',
      top: `-${scrollY}px`,
      left: '0',
      right: '0',
      overflow: 'hidden',
    });

    return () => {
      document.body.style.cssText = bodyStyle;
      document.documentElement.style.overflow = htmlOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [locked]);
}
