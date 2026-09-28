/**
 * 待ち時間の見張り（issue #20）。
 *
 * `AbortSignal.timeout` / `AbortSignal.any` は使わない。互換性のためではなく、次の3つを
 * 自前で持つ必要があるため:
 * - 受信が進むたびに猶予を延ばす（blob は合計時間ではなく、受信が止まっている時間で見る）
 * - 画面が見えていない間は数えない（下の `VisibilitySource`）
 * - 中断の前に「時間がかかっています」の段階を持つ
 *
 * 時間切れは呼び出し側の中断口とは別の、子の中断口で表す。`useGitHubImport` の `run` は
 * 自分の中断口が中断されたら結果を黙って捨てる（閉じた・新しい取得に置き換わった扱い）ので、
 * 時間切れでそれを中断すると、失敗が画面に出ず、読み込み中でもエラーでもない状態に残る。
 */

/**
 * 画面が見えているか。`document.hidden` の間は、利用者が待っている状態を見られないので
 * 猶予に数えず、表示に戻った時点から最初から数え直す。ブラウザが背面でタイマーや通信を
 * どう止めるかには頼らない（製品側の方針として決める）。
 */
export interface VisibilitySource {
  isHidden(): boolean;
  /** 見える／見えないが変わったら呼ぶ。戻り値で購読をやめる。 */
  onChange(listener: () => void): () => void;
}

/** 実行中のページの `document`。無い環境（Node のテストなど）では null。 */
export function documentVisibility(): VisibilitySource | null {
  if (typeof document === 'undefined') return null;
  return {
    isHidden: () => document.visibilityState === 'hidden',
    onChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export interface Watchdog {
  /** 猶予を最初から数え直す（進みがあった）。発火済み・片付け済みなら何もしない。 */
  restart(): void;
  dispose(): void;
}

/**
 * `ms` のあいだ `restart` されなければ `onFire` を1回だけ呼ぶ。
 * 画面が見えていない間は数えず、見えるようになったら最初から数え直す。
 */
export function createWatchdog(
  ms: number,
  onFire: () => void,
  visibility: VisibilitySource | null = documentVisibility(),
): Watchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clear();
    if (done || visibility?.isHidden()) return;
    timer = setTimeout(() => {
      timer = null;
      finish();
      onFire();
    }, ms);
  };
  const unsubscribe = visibility?.onChange(arm) ?? ((): void => {});
  const finish = (): void => {
    done = true;
    clear();
    unsubscribe();
  };

  arm();
  return { restart: arm, dispose: finish };
}

/** 時間切れの中断理由。呼び出し側の中断（AbortError）と見分けるために名前を分ける。 */
export function timeoutReason(): DOMException {
  return new DOMException('GitHub の応答を待つ上限を超えました', 'TimeoutError');
}

export interface Deadline {
  /** 呼び出し側の中断と、時間切れのどちらでも中断される。fetch と本文の読み取りに渡す。 */
  readonly signal: AbortSignal;
  /** 時間切れで中断したか（呼び出し側の中断では false のまま）。 */
  readonly timedOut: boolean;
  /** 受信が進んだ。猶予を最初から数え直す。 */
  extend(): void;
  dispose(): void;
}

/**
 * `parent` を親にした子の中断口と、その見張りを作る。
 *
 * 片付け（`dispose`）は本文を読み終えるまで呼ばない。応答ヘッダが返った時点で解除すると、
 * ヘッダのあとに本文が止まったときに切れなくなる。
 */
export function createDeadline(
  parent: AbortSignal,
  ms: number,
  visibility: VisibilitySource | null = documentVisibility(),
): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  if (parent.aborted) {
    controller.abort(parent.reason);
    return {
      signal: controller.signal,
      timedOut: false,
      extend: () => {},
      dispose: () => {},
    };
  }

  const watchdog = createWatchdog(
    ms,
    () => {
      timedOut = true;
      controller.abort(timeoutReason());
    },
    visibility,
  );
  const abortFromParent = (): void => {
    watchdog.dispose();
    controller.abort(parent.reason);
  };
  parent.addEventListener('abort', abortFromParent, { once: true });

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    extend: () => watchdog.restart(),
    dispose: () => {
      watchdog.dispose();
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}

/**
 * `run` を期限付きで走らせる。
 *
 * - 呼び出し側（`parent`）の中断は、そのまま投げ直す（呼び出し側が「中断」として黙って捨てる）
 * - 時間切れで中断したときだけ、`onTimeout` の失敗に置き換える
 * - `isClassified` に当たる失敗（分類済みの HTTP の失敗など）は、時間切れと重なっても
 *   そのまま通す（401 を時間切れと見せると、接続を切るべき場面で再試行を出してしまう）
 */
export async function withDeadline<T>(
  parent: AbortSignal,
  ms: number,
  run: (deadline: Deadline) => Promise<T>,
  onTimeout: () => Error,
  isClassified: (error: unknown) => boolean,
  visibility: VisibilitySource | null = documentVisibility(),
): Promise<T> {
  const deadline = createDeadline(parent, ms, visibility);
  try {
    return await run(deadline);
  } catch (error) {
    if (!parent.aborted && deadline.timedOut && !isClassified(error)) throw onTimeout();
    throw error;
  } finally {
    deadline.dispose();
  }
}
