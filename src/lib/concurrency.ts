/**
 * `items` を最大 `limit` 件ずつ並行して `worker` に通す。結果は入力と同じ順に並ぶ。
 *
 * 1件でも失敗したら新しい処理を始めず、走っている処理にも中断を伝えて、最初の失敗で
 * reject する。全件そろわないと使えない取り込みで、残りを取り続けても無駄になるので。
 * 親の `signal` が中断されたときも同じく止める。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  worker: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abortFromParent, { once: true });

  let cursor = 0;
  let firstError: unknown = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && firstError === null) {
      if (controller.signal.aborted) {
        firstError ??= new DOMException('Aborted', 'AbortError');
        return;
      }
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await worker(item, controller.signal);
      } catch (error) {
        if (firstError === null) {
          firstError = error;
          controller.abort();
        }
        return;
      }
    }
  });

  try {
    await Promise.all(runners);
  } finally {
    signal.removeEventListener('abort', abortFromParent);
  }
  if (firstError !== null) throw firstError;
  return results;
}
