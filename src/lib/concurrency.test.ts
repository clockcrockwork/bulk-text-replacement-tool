import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

/** 中断されるまで待ち、中断されたら AbortError で終わる処理。 */
function waitUntilAborted(signal: AbortSignal, onAbort: () => void): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        onAbort();
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

describe('mapWithConcurrency', () => {
  it('同時に走らせる数を上限以下に抑え、結果は入力の順に並べる', async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      2,
      new AbortController().signal,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('空の入力は何も呼ばずに空の結果を返す', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, new AbortController().signal, async () => {
      calls += 1;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('1件失敗したら新しい処理を始めず、走っている処理も中断する', async () => {
    const started: number[] = [];
    const aborted: number[] = [];

    await expect(
      mapWithConcurrency(
        [1, 2, 3, 4, 5],
        2,
        new AbortController().signal,
        async (value, signal) => {
          started.push(value);
          if (value === 1) throw new Error('boom');
          return waitUntilAborted(signal, () => aborted.push(value));
        },
      ),
    ).rejects.toThrow('boom');

    expect(started).toEqual([1, 2]);
    expect(aborted).toEqual([2]);
  });

  it('親の signal が中断されたら、走っている処理を中断し、残りを始めない', async () => {
    const parent = new AbortController();
    const started: number[] = [];
    const aborted: number[] = [];

    const running = mapWithConcurrency([1, 2, 3, 4], 2, parent.signal, async (value, signal) => {
      started.push(value);
      return waitUntilAborted(signal, () => aborted.push(value));
    });
    await Promise.resolve();
    parent.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toEqual([1, 2]);
    expect(aborted).toEqual([1, 2]);
  });

  it('始める前に中断済みなら、何も呼ばずに AbortError で終わる', async () => {
    const parent = new AbortController();
    parent.abort();
    let calls = 0;
    await expect(
      mapWithConcurrency([1, 2], 2, parent.signal, async () => {
        calls += 1;
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});
