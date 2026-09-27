import type { BatchSourceMatch } from './inputSource';

/**
 * 計画画面・確認画面に一度に並べる行の上限。
 *
 * 件数に上限を設けない（警告だけ）ので、数万件の選択もあり得る。全件を行にすると、
 * 警告を読んで判断するための画面そのものが重くなって固まる。並べるのは先頭だけにし、
 * 残りは件数で示す。
 */
export const BATCH_LIST_LIMIT = 100;

/** 一覧のうち、いま表示している範囲。`start` は含み、`end` は含まない。 */
export interface ListPage {
  index: number;
  count: number;
  start: number;
  end: number;
}

/**
 * 確認画面の一覧を `size` 件ずつに区切ったときの、`requested` 番目のページ。
 *
 * 確認画面では、同じ取り込み元の候補は1件ずつ決める必要があり、決める手段が一覧の中に
 * しか無い。先頭だけを見せて残りを件数で示すと、101件目以降の候補に手が届かず確定できなく
 * なる。並べる数は抑えたまま、すべての行へ到達できるようにページで送る。決めても行の位置は
 * 動かさない（操作中の選択欄が目の前から消えないように）。範囲外の番号は端に寄せる。
 */
export function listPage(total: number, requested: number, size = BATCH_LIST_LIMIT): ListPage {
  const count = Math.max(1, Math.ceil(total / size));
  const index = Math.min(Math.max(0, requested), count - 1);
  const start = index * size;
  return { index, count, start, end: Math.min(total, start + size) };
}

/** 候補1件の取り込み方法。 */
export type BatchChoice = { action: 'add' } | { action: 'update'; inputId: string };

/** 取り込み方法を決めた候補（キーはリポジトリ内のパス）。未決定の候補は含めない。 */
export type BatchChoices = ReadonlyMap<string, BatchChoice>;

/** App に渡す、候補1件の取り込み方法。 */
export type GitHubBatchDecision = { path: string } & BatchChoice;

/** 同じ取り込み元の入力があり、追加か更新かを利用者が決める必要がある候補か。 */
export function needsDecision(match: BatchSourceMatch): boolean {
  return match.sameSource.length > 0;
}

/**
 * 最初の取り込み方法。同じ取り込み元が無い候補は「追加」に決め、ある候補は未決定から
 * 始める（更新先を推測しない。仕様 §9）。
 */
export function initialBatchChoices(
  matches: readonly BatchSourceMatch[],
): Map<string, BatchChoice> {
  const choices = new Map<string, BatchChoice>();
  for (const match of matches) {
    if (!needsDecision(match)) choices.set(match.path, { action: 'add' });
  }
  return choices;
}

/**
 * 確認画面に並べる順。判断が要る候補、目を通してほしい候補（`isNotable`。同名の警告や
 * Shift_JIS の推測など）、それ以外の順にし、同じ段の中では元の順を保つ。
 * 並べる数を絞っても、決めなければならない行や注意の要る行が一覧の外に隠れにくくする。
 */
export function orderForReview(
  matches: readonly BatchSourceMatch[],
  isNotable: (match: BatchSourceMatch) => boolean = () => false,
): BatchSourceMatch[] {
  const tier = (match: BatchSourceMatch): number =>
    needsDecision(match) ? 0 : isNotable(match) ? 1 : 2;
  // Array.prototype.sort は安定なので、同じ段の中の順は崩れない。
  return [...matches].sort((a, b) => tier(a) - tier(b));
}

export function countUndecided(
  matches: readonly BatchSourceMatch[],
  choices: BatchChoices,
): number {
  return matches.filter((match) => !choices.has(match.path)).length;
}

/**
 * 未決定のうち、同じ取り込み元の入力がちょうど1件の候補を、その入力の更新に決める。
 *
 * 更新先が1件しか無いので推測にはならない。2件以上ある候補は、どれを更新するかを
 * 利用者が1件ずつ決める（ここでは触らない）。決め済みの候補も上書きしない。
 */
export function chooseSingleUpdates(
  matches: readonly BatchSourceMatch[],
  choices: BatchChoices,
): Map<string, BatchChoice> {
  const next = new Map(choices);
  for (const match of matches) {
    const [only, ...rest] = match.sameSource;
    if (next.has(match.path) || !only || rest.length > 0) continue;
    next.set(match.path, { action: 'update', inputId: only.id });
  }
  return next;
}

/** 未決定の候補をすべて「別の入力として追加」に決める。決め済みの候補は上書きしない。 */
export function chooseAddForUndecided(
  matches: readonly BatchSourceMatch[],
  choices: BatchChoices,
): Map<string, BatchChoice> {
  const next = new Map(choices);
  for (const match of matches) {
    if (!next.has(match.path)) next.set(match.path, { action: 'add' });
  }
  return next;
}

/**
 * `<select>` の値との相互変換。`add` と `update:<入力の ID>` の形にする。
 * 入力の ID は作業データから来る任意の文字列なので、特別な値と取り違えないよう接頭辞で分ける。
 */
export function choiceToValue(choice: BatchChoice | undefined): string {
  if (!choice) return '';
  return choice.action === 'add' ? 'add' : `update:${choice.inputId}`;
}

export function valueToChoice(value: string): BatchChoice | null {
  if (value === 'add') return { action: 'add' };
  if (value.startsWith('update:') && value.length > 'update:'.length) {
    return { action: 'update', inputId: value.slice('update:'.length) };
  }
  return null;
}

/** 決めた取り込み方法を App に渡す形にする。未決定の候補は含めない。 */
export function toBatchDecisions(
  matches: readonly BatchSourceMatch[],
  choices: BatchChoices,
): GitHubBatchDecision[] {
  return matches.flatMap((match): GitHubBatchDecision[] => {
    const choice = choices.get(match.path);
    return choice ? [{ path: match.path, ...choice }] : [];
  });
}
