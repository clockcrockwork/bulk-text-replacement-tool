import { type MouseEvent, type PointerEvent, type RefObject, useRef } from 'react';

/**
 * モーダルの `<dialog>` を、背景（ダイアログの外側）のクリックで閉じる。
 *
 * `click` は、押した要素と離した要素の共通の祖先で発火する。そのため、中で文字をドラッグして
 * 選び、外側で離すと `event.target` がダイアログ自身になり、背景のクリックと区別できない。
 * 本文を選んでコピーするのは確認画面でよくする操作なので、押した位置も背景だったときだけ閉じる。
 */
export function useBackdropClose(
  dialogRef: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
): {
  onPointerDown: (event: PointerEvent<HTMLDialogElement>) => void;
  onClick: (event: MouseEvent<HTMLDialogElement>) => void;
} {
  const pressedOnBackdrop = useRef(false);
  return {
    onPointerDown: (event) => {
      pressedOnBackdrop.current = event.target === dialogRef.current;
    },
    onClick: (event) => {
      const fromBackdrop = pressedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      if (fromBackdrop && event.target === dialogRef.current) onClose();
    },
  };
}
