import { describe, expect, it } from 'vitest';
import {
  type BatchChoice,
  choiceToValue,
  chooseAddForUndecided,
  chooseSingleUpdates,
  countUndecided,
  initialBatchChoices,
  needsDecision,
  orderForReview,
  toBatchDecisions,
  valueToChoice,
} from './githubBatchReview';
import type { BatchSourceMatch } from './inputSource';

function match(path: string, targets: string[] = [], titleCollision = false): BatchSourceMatch {
  return {
    path,
    sameSource: targets.map((id) => ({ id, label: `${id} のラベル` })),
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
    const choices = initialBatchChoices([PLAIN, SINGLE, MULTI]);
    expect(choices).toEqual(new Map([['a.md', { action: 'add' }]]));
    expect(countUndecided([PLAIN, SINGLE, MULTI], choices)).toBe(2);
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
