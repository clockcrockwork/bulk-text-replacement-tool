import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversionInput } from '../lib/replace';
import {
  type ConversionOutcome,
  type ConversionRun,
  startConversion,
} from '../workers/conversionClient';

/** 変換中の進み（ファイル単位）。 */
export interface ConversionActivity {
  /** 始めた変換の指紋（`workspaceSignature`）。変わったら取り消す。 */
  signature: string;
  /** 取りかかっているファイルの番号（1始まり、全グループ通し）。 */
  current: number;
  total: number;
}

export interface Conversion {
  /** 変換中なら進み。変換していなければ null。 */
  activity: ConversionActivity | null;
  /** 変換を始める。走っている変換は取り消す（結末は `cancelled`）。 */
  start: (input: ConversionInput, signature: string) => Promise<ConversionOutcome>;
  /** 走っている変換を取り消す。 */
  cancel: () => void;
}

/**
 * 変換を Web Worker で走らせる（issue #31）。走っている間も画面は操作できる。
 *
 * 進みの表示はファイルが変わったときだけ更新する（パスごとに描き直すと、ルールの多い
 * 変換で描画が追いつかない）。画面を閉じたら Worker ごと止める。
 */
export function useConversion(): Conversion {
  const running = useRef<ConversionRun | null>(null);
  const [activity, setActivity] = useState<ConversionActivity | null>(null);

  useEffect(() => () => running.current?.cancel(), []);

  const start = async (input: ConversionInput, signature: string): Promise<ConversionOutcome> => {
    running.current?.cancel();
    const total = input.groups.length * input.inputs.length;
    setActivity({ signature, current: 1, total });
    const run = startConversion(input, {
      onProgress: ({ groupIndex, inputIndex }) => {
        const current = groupIndex * input.inputs.length + inputIndex + 1;
        setActivity((prev) =>
          prev && prev.signature === signature && prev.current !== current
            ? { ...prev, current }
            : prev,
        );
      },
    });
    running.current = run;
    const outcome = await run.outcome;
    // 後から始めた変換が表示を持っているなら触らない。
    if (running.current === run) {
      running.current = null;
      setActivity(null);
    }
    return outcome;
  };

  // 表示もその場で消す。結末（`cancelled`）が届くのを待つと、その間のレンダーで
  // 「まだ変換中」に見え、取り消しを二重に行い得る。
  const cancel = useCallback((): void => {
    running.current?.cancel();
    running.current = null;
    setActivity(null);
  }, []);

  return { activity, start, cancel };
}
