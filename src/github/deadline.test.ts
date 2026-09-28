import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeadline,
  createWatchdog,
  timeoutReason,
  type VisibilitySource,
  withDeadline,
} from './deadline';

/** 見える／見えないを手で切り替えられる `document` の代わり。 */
function fakeVisibility(hidden = false) {
  let isHidden = hidden;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    isHidden: () => isHidden,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    set(next: boolean) {
      isHidden = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createWatchdog', () => {
  it('進みが無ければ1回だけ発火し、進みがあれば最初から数え直す', () => {
    const onFire = vi.fn();
    const watchdog = createWatchdog(1000, onFire, null);
    vi.advanceTimersByTime(900);
    watchdog.restart();
    vi.advanceTimersByTime(900);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(1);
    // 発火したあとは数え直さない。
    watchdog.restart();
    vi.advanceTimersByTime(5000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('見えていない間は数えず、見えるようになったら最初から数え直す', () => {
    const visibility = fakeVisibility();
    const onFire = vi.fn();
    createWatchdog(1000, onFire, visibility.source);
    vi.advanceTimersByTime(900);
    visibility.set(true);
    vi.advanceTimersByTime(60_000);
    expect(onFire).not.toHaveBeenCalled();
    visibility.set(false);
    vi.advanceTimersByTime(999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('最初から見えていなければ、見えるまで数え始めない', () => {
    const visibility = fakeVisibility(true);
    const onFire = vi.fn();
    createWatchdog(1000, onFire, visibility.source);
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
    visibility.set(false);
    vi.advanceTimersByTime(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('片付けたらタイマーも購読も残らない', () => {
    const visibility = fakeVisibility();
    const onFire = vi.fn();
    const watchdog = createWatchdog(1000, onFire, visibility.source);
    watchdog.dispose();
    expect(visibility.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('発火したあとも購読を残さない', () => {
    const visibility = fakeVisibility();
    createWatchdog(1000, () => {}, visibility.source);
    vi.advanceTimersByTime(1000);
    expect(visibility.listeners.size).toBe(0);
  });
});

describe('createDeadline', () => {
  it('期限で子だけを TimeoutError で中断し、親は中断しない', () => {
    const parent = new AbortController();
    const deadline = createDeadline(parent.signal, 1000, null);
    vi.advanceTimersByTime(1000);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as DOMException).name).toBe('TimeoutError');
    expect(deadline.timedOut).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('親の中断は子へ伝わるが、時間切れとは数えない', () => {
    const parent = new AbortController();
    const deadline = createDeadline(parent.signal, 1000, null);
    parent.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(deadline.timedOut).toBe(false);
  });

  it('親が中断済みなら、見張りを始めない', () => {
    const parent = new AbortController();
    parent.abort();
    const deadline = createDeadline(parent.signal, 1000, null);
    expect(deadline.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    deadline.extend();
    deadline.dispose();
    expect(deadline.timedOut).toBe(false);
  });

  it('extend で猶予が延びる（受信が進んでいる間は切らない）', () => {
    const deadline = createDeadline(new AbortController().signal, 1000, null);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(900);
      deadline.extend();
    }
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(deadline.timedOut).toBe(true);
  });

  it('片付けたら、あとから親を中断しても子へ伝えない（リスナーを残さない）', () => {
    const parent = new AbortController();
    const deadline = createDeadline(parent.signal, 1000, null);
    deadline.dispose();
    parent.abort();
    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withDeadline', () => {
  const onTimeout = () => new Error('timeout');
  const never = (): boolean => false;

  /** 渡された signal が中断されるまで終わらない処理。 */
  const hang = ({ signal }: { signal: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  it('時間切れは onTimeout の失敗に置き換える', async () => {
    const result = withDeadline(new AbortController().signal, 1000, hang, onTimeout, never, null);
    const settled = expect(result).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('呼び出し側の中断は、そのまま投げ直す（時間切れにしない）', async () => {
    const parent = new AbortController();
    const result = withDeadline(parent.signal, 1000, hang, onTimeout, never, null);
    parent.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('分類済みの失敗は、時間切れと重なってもそのまま通す', async () => {
    const classified = new Error('401');
    const result = withDeadline(
      new AbortController().signal,
      1000,
      async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw classified;
      },
      onTimeout,
      (error) => error === classified,
      null,
    );
    const settled = expect(result).rejects.toBe(classified);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('終わったら見張りを片付ける', async () => {
    await expect(
      withDeadline(new AbortController().signal, 1000, async () => 'ok', onTimeout, never, null),
    ).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('時間切れの理由は AbortError と名前で見分けられる', () => {
    expect(timeoutReason().name).toBe('TimeoutError');
  });
});
