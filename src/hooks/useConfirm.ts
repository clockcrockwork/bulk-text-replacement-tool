import { useCallback, useRef, useState } from 'react';
import type { ConfirmRequest } from '../components/ConfirmDialog';

interface Pending {
  request: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

export interface Confirm {
  /** 確認を出して、ユーザーの選択を待つ。 */
  ask: (request: ConfirmRequest) => Promise<boolean>;
  /** 表示中の確認。無ければ null。 */
  pending: ConfirmRequest | null;
  accept: () => void;
  reject: () => void;
}

/**
 * 破壊操作の確認を Promise で待てるようにする。
 *
 * 呼び出し側を `if (await confirm.ask(...)) { ... }` と書けるようにするのが目的。
 * コールバックを配り歩くと、確認を出す場所と実行する場所が離れて、
 * 「確認を付け忘れた経路」が生まれやすい。
 */
export function useConfirm(): Confirm {
  const [pending, setPending] = useState<Pending | null>(null);
  // 応答は1回だけ。二重に resolve しても後続を無視する。
  const pendingRef = useRef<Pending | null>(null);

  const settle = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
  }, []);

  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        // 先に出ていた確認は、答えないまま消えるのでキャンセル扱いにする。
        pendingRef.current?.resolve(false);
        const next = { request, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  return {
    ask,
    pending: pending?.request ?? null,
    accept: useCallback(() => settle(true), [settle]),
    reject: useCallback(() => settle(false), [settle]),
  };
}
