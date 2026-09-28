import { describe, expect, it } from 'vitest';
import {
  type BatchChoice,
  choiceToValue,
  chooseAddForUndecided,
  chooseSingleUpdates,
  countSingleUpdates,
  countUndecided,
  effectiveBatchChoices,
  firstUndecidedIndex,
  isUnchangedTarget,
  listPage,
  needsDecision,
  orderForReview,
  summarizeOutcome,
  toBatchDecisions,
  UPDATE_TARGET_OPTION_LIMIT,
  updateTargetAt,
  valueToChoice,
  visibleUpdateTargets,
} from './githubBatchReview';
import type { BatchSourceMatch } from './inputSource';

/** 更新先は、既定では前回の取り込み（`old`）から GitHub 側が変わった候補にする。 */
function match(
  path: string,
  targets: string[] = [],
  titleCollision = false,
  targetBlob = 'old',
): BatchSourceMatch {
  return {
    path,
    blobSha: 'new',
    sameSource: targets.map((id, index) => ({
      id,
      label: `${id} のラベル`,
      position: index + 1,
      blobSha: targetBlob,
    })),
    titleCollision,
  };
}

const PLAIN = match('a.md');
const SINGLE = match('b.md', ['in1']);
const MULTI = match('c.md', ['in2', 'in3']);
const NOTABLE = match('d.md', [], true);

describe('一括取り込みの確認', () => {
  it('同じ取り込み元がある候補だけが判断を要し、最初は未決定になる', () => {
    expect([PLAIN, SINGLE, MULTI].map(needsDecision)).toEqual([false, true, true]);
    const choices = effectiveBatchChoices([PLAIN, SINGLE, MULTI], new Map());
    expect(choices).toEqual(new Map([['a.md', { action: 'add' }]]));
    expect(countUndecided([PLAIN, SINGLE, MULTI], choices)).toBe(2);
  });

  it('決めた内容は、今も成り立つものだけを使う（閉じている間に入力が変わり得る）', () => {
    const stored = new Map<string, BatchChoice>([
      ['a.md', { action: 'update', inputId: 'gone' }],
      ['b.md', { action: 'update', inputId: 'in1' }],
      ['c.md', { action: 'update', inputId: 'deleted' }],
    ]);
    const choices = effectiveBatchChoices([PLAIN, SINGLE, MULTI], stored);
    // 同じ取り込み元が無くなった候補は「追加」に決まる。
    expect(choices.get('a.md')).toEqual({ action: 'add' });
    expect(choices.get('b.md')).toEqual({ action: 'update', inputId: 'in1' });
    // 更新先が消えていれば、推測せず未決定に戻す。
    expect(choices.has('c.md')).toBe(false);
    expect(
      effectiveBatchChoices([MULTI], new Map([['c.md', { action: 'add' }]])).get('c.md'),
    ).toEqual({ action: 'add' });
  });

  it('判断が要るもの、注意が要るもの、それ以外の順に並べ、同じ段では元の順を保つ', () => {
    const later = match('e.md');
    const ordered = orderForReview(
      [PLAIN, NOTABLE, SINGLE, later, MULTI],
      (item) => item.titleCollision,
    );
    expect(ordered.map((item) => item.path)).toEqual(['b.md', 'c.md', 'd.md', 'a.md', 'e.md']);
    // 注意の判定を渡さなければ、判断が要るものだけを先に出す。
    expect(orderForReview([PLAIN, SINGLE]).map((item) => item.path)).toEqual(['b.md', 'a.md']);
  });

  it('更新先が1件の未決定だけをまとめて更新に決め、2件以上や決め済みには触れない', () => {
    const decided = new Map<string, BatchChoice>([['a.md', { action: 'add' }]]);
    const next = chooseSingleUpdates([PLAIN, SINGLE, MULTI], decided);
    expect(next.get('b.md')).toEqual({ action: 'update', inputId: 'in1' });
    expect(next.has('c.md')).toBe(false);
    expect(next.get('a.md')).toEqual({ action: 'add' });

    const alreadyAdd = new Map<string, BatchChoice>([['b.md', { action: 'add' }]]);
    expect(chooseSingleUpdates([SINGLE], alreadyAdd).get('b.md')).toEqual({ action: 'add' });
  });

  it('GitHub 側が変わっていない候補は、まとめて更新する対象から外す（1件ずつなら選べる）', () => {
    const unchanged = match('u.md', ['in9'], false, 'new');
    expect(
      isUnchangedTarget(unchanged, { id: 'in9', label: '', position: 1, blobSha: 'new' }),
    ).toBe(true);
    const next = chooseSingleUpdates([SINGLE, unchanged], new Map());
    expect(next.get('b.md')).toEqual({ action: 'update', inputId: 'in1' });
    expect(next.has('u.md')).toBe(false);
    expect(countSingleUpdates([SINGLE, unchanged, MULTI], new Map())).toBe(1);
    expect(countSingleUpdates([SINGLE], next)).toBe(0);
  });

  it('確定すると追加・置き換えが何件になり、うち何件が変わっていない候補かを数える', () => {
    const unchanged = match('u.md', ['in9'], false, 'new');
    const choices = new Map<string, BatchChoice>([
      ['a.md', { action: 'add' }],
      ['b.md', { action: 'update', inputId: 'in1' }],
      ['u.md', { action: 'update', inputId: 'in9' }],
    ]);
    expect(summarizeOutcome([PLAIN, SINGLE, unchanged, MULTI], choices)).toEqual({
      adds: 1,
      updates: 2,
      unchangedUpdates: 1,
    });
  });

  it('並べた順で最初の未決定を探す', () => {
    const choices = new Map<string, BatchChoice>([['b.md', { action: 'add' }]]);
    expect(firstUndecidedIndex([SINGLE, MULTI], choices)).toBe(1);
    expect(firstUndecidedIndex([SINGLE], choices)).toBeNull();
  });

  it('未決定をまとめて追加に決め、決め済みは上書きしない', () => {
    const decided = new Map<string, BatchChoice>([['b.md', { action: 'update', inputId: 'in1' }]]);
    const next = chooseAddForUndecided([PLAIN, SINGLE, MULTI], decided);
    expect(next.get('b.md')).toEqual({ action: 'update', inputId: 'in1' });
    expect(next.get('c.md')).toEqual({ action: 'add' });
    expect(countUndecided([PLAIN, SINGLE, MULTI], next)).toBe(0);
  });

  it('選択欄の値と相互に変換でき、入力の ID が特別な値と同じ文字列でも取り違えない', () => {
    const add: BatchChoice = { action: 'add' };
    const update: BatchChoice = { action: 'update', inputId: 'add' };
    expect(valueToChoice(choiceToValue(add))).toEqual(add);
    expect(valueToChoice(choiceToValue(update))).toEqual(update);
    expect(choiceToValue(undefined)).toBe('');
    expect(valueToChoice('')).toBeNull();
    expect(valueToChoice('update:')).toBeNull();
    expect(valueToChoice('something')).toBeNull();
  });

  it('App へ渡すのは決めた候補だけ', () => {
    const choices = new Map<string, BatchChoice>([
      ['a.md', { action: 'add' }],
      ['b.md', { action: 'update', inputId: 'in1' }],
    ]);
    expect(toBatchDecisions([PLAIN, SINGLE, MULTI], choices)).toEqual([
      { path: 'a.md', action: 'add' },
      { path: 'b.md', action: 'update', inputId: 'in1' },
    ]);
  });
});

describe('確認画面の一覧のページ', () => {
  it('100件ずつに区切り、最後のページは残りだけにする', () => {
    expect(listPage(250, 0)).toEqual({ index: 0, count: 3, start: 0, end: 100 });
    expect(listPage(250, 2)).toEqual({ index: 2, count: 3, start: 200, end: 250 });
  });

  it('範囲外の番号は端に寄せ、0件でも1ページとして扱う', () => {
    expect(listPage(250, 9)).toEqual({ index: 2, count: 3, start: 200, end: 250 });
    expect(listPage(250, -1)).toEqual({ index: 0, count: 3, start: 0, end: 100 });
    expect(listPage(0, 0)).toEqual({ index: 0, count: 1, start: 0, end: 0 });
    expect(listPage(100, 1)).toEqual({ index: 0, count: 1, start: 0, end: 100 });
  });
});

describe('更新先の選択肢', () => {
  const targets = Array.from({ length: UPDATE_TARGET_OPTION_LIMIT + 10 }, (_, index) => ({
    id: `in${index}`,
    label: `${index + 1} x.md`,
    position: index + 1,
    blobSha: 'old',
  }));

  it('上限件ずつ区切って並べ、ページを送ればどの更新先にも届く', () => {
    expect(visibleUpdateTargets(targets, null)).toHaveLength(UPDATE_TARGET_OPTION_LIMIT);
    const second = visibleUpdateTargets(targets, null, 1);
    expect(second.map((target) => target.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `in${UPDATE_TARGET_OPTION_LIMIT + index}`),
    );
    // 範囲外のページは端に寄せる。
    expect(visibleUpdateTargets(targets, null, 9)).toEqual(second);
  });

  it('範囲外の更新先を選んでいれば、それも並べる（選んだ値を選択欄に残す）', () => {
    const shown = visibleUpdateTargets(targets, 'in55');
    expect(shown).toHaveLength(UPDATE_TARGET_OPTION_LIMIT + 1);
    expect(shown.at(-1)?.id).toBe('in55');
    expect(visibleUpdateTargets(targets, 'in3')).toHaveLength(UPDATE_TARGET_OPTION_LIMIT);
    // 別のページを見ているときも、選んだ更新先は残す。
    expect(visibleUpdateTargets(targets, 'in3', 1).at(-1)?.id).toBe('in3');
  });

  it('一覧の番号で更新先を探し、この候補の更新先でなければ null', () => {
    expect(updateTargetAt(targets, 56)?.id).toBe('in55');
    expect(updateTargetAt(targets, 999)).toBeNull();
  });
});
