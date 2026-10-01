import {
  CONVERSION_STALL_TIMEOUT_MS,
  type ConversionStop,
  isConversionWorkerMessage,
} from '../lib/conversionProtocol';
import type { ConversionInput, ConversionProgress } from '../lib/replace';
import type { ConversionResult } from '../types';

/** 変換の結末。 */
export type ConversionOutcome =
  | { kind: 'done'; result: ConversionResult }
  | { kind: 'stopped'; stop: ConversionStop }
  /** 呼び出し側が取り消した（`cancel`）。知らせは呼び出し側が決める。 */
  | { kind: 'cancelled' };

export interface ConversionRun {
  readonly outcome: Promise<ConversionOutcome>;
  /** 走っている変換を Worker ごと止める。終わったあとに呼んでも何もしない。 */
  cancel: () => void;
}

/** 使う Worker の機能だけ。テストでは差し替える。 */
export interface ConversionWorker {
  postMessage: (message: unknown) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface ConversionRunOptions {
  /** パスの進みを受け取る。 */
  onProgress?: (progress: ConversionProgress) => void;
  /** 進みが無いまま、これだけ経ったら止める。 */
  stallMs?: number;
  createWorker?: () => ConversionWorker;
}

function createConversionWorker(): ConversionWorker {
  return new Worker(new URL('./conversion.worker.ts', import.meta.url), {
    type: 'module',
    name: 'conversion',
  });
}

/**
 * 変換を Worker で始める。変換ごとに Worker を作って、終わったら捨てる。
 *
 * 破滅的なバックトラックに入った正規表現は Worker の中からも止められないので、
 * 止めるのは常に `terminate`。使い回すと、止めたあとの Worker を作り直す経路が要る。
 *
 * 時間は変換全体ではなく、パスの進み（`progress`）の間隔で数える。届くたびに数え直すので、
 * ファイルやルールが多いだけの長い変換は止めず、1つのパスで止まったものだけを止める。
 */
export function startConversion(
  input: ConversionInput,
  {
    onProgress,
    stallMs = CONVERSION_STALL_TIMEOUT_MS,
    createWorker = createConversionWorker,
  }: ConversionRunOptions = {},
): ConversionRun {
  let settle: (outcome: ConversionOutcome) => void = () => {};
  const outcome = new Promise<ConversionOutcome>((resolve) => {
    settle = resolve;
  });

  let worker: ConversionWorker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastProgress: ConversionProgress | null = null;
  let finished = false;

  const finish = (result: ConversionOutcome): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    worker?.terminate();
    worker = null;
    settle(result);
  };

  const watch = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      finish({ kind: 'stopped', stop: { kind: 'stalled', ms: stallMs, progress: lastProgress } });
    }, stallMs);
  };

  try {
    worker = createWorker();
  } catch (error) {
    // Worker を作れない（古いブラウザ・CSP）。メインスレッドへ戻すと固まる経路が残るので戻さない。
    console.error('変換用の Worker を作れませんでした', error);
    finish({ kind: 'stopped', stop: { kind: 'failed' } });
    return { outcome, cancel: () => {} };
  }

  worker.onmessage = (event) => {
    const message = event.data;
    if (finished || !isConversionWorkerMessage(message)) return;
    switch (message.kind) {
      case 'progress':
        lastProgress = message.progress;
        watch();
        onProgress?.(message.progress);
        return;
      case 'done':
        finish({ kind: 'done', result: message.result });
        return;
      case 'tooLarge':
        finish({
          kind: 'stopped',
          stop: {
            kind: 'tooLarge',
            ruleId: message.ruleId,
            groupId: message.groupId,
            inputIndex: message.inputIndex,
          },
        });
        return;
      case 'failed':
        finish({ kind: 'stopped', stop: { kind: 'failed' } });
        return;
    }
  };
  worker.onerror = (event) => {
    // スクリプトを読めない・Worker の中の想定外の例外。ここで受けないと待ち続ける。
    event.preventDefault();
    finish({ kind: 'stopped', stop: { kind: 'failed' } });
  };

  watch();
  worker.postMessage(input);
  return { outcome, cancel: () => finish({ kind: 'cancelled' }) };
}
