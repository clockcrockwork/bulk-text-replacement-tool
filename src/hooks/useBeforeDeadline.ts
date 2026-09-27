import { useEffect, useState } from 'react';

/**
 * `setTimeout` に渡せる最大の遅延（ミリ秒）。これを超えると、ブラウザは即座に発火させる。
 * 期限がもっと先でも、この長さで一度起きて測り直す。
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * いまが `deadline`（ミリ秒）より前かを返し、期限が来たら描画し直す。
 *
 * 残り時間は描画のたびに今の時刻から求める（期限が別の値に変わっても、古い時刻で
 * 数えない）。タイマーは期限の変更と、自分が起きたときだけ張り直す。
 */
export function useBeforeDeadline(deadline: number | null): boolean {
  const [wakeups, setWakeups] = useState(0);
  const wait = deadline === null ? 0 : Math.max(0, deadline - Date.now());
  const waiting = wait > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 起きた回数（wakeups）で張り直すため、wait そのものは依存に入れない（描画のたびに張り直さない）
  useEffect(() => {
    if (!waiting || deadline === null) return;
    const delay = Math.min(Math.max(0, deadline - Date.now()), MAX_TIMEOUT_MS);
    const timer = window.setTimeout(() => setWakeups((count) => count + 1), delay);
    return () => window.clearTimeout(timer);
  }, [deadline, waiting, wakeups]);

  return waiting;
}
