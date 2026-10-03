import { describe, expect, it } from 'vitest';
import type { Group, InputText, Rule } from '../types';
import {
  type ConversionWorkerMessage,
  describeConversionStop,
  handleConversionRequest,
  isConversionInput,
  isConversionWorkerMessage,
} from './conversionProtocol';
import { MAX_CONVERSION_OUTPUT_CODE_UNITS } from './inputLimits';

function rule(
  id: string,
  src: string,
  values: Record<string, string>,
  extra: Partial<Rule> = {},
): Rule {
  return { id, src, regex: false, cs: true, order: 'sim', values, ...extra };
}

/** 右から左への上書き（U+202E）。ソースに直接書くと見えないまま壊れるので、作って使う。 */
const RLO = String.fromCodePoint(0x202e);

const GROUPS: Group[] = [
  { id: 'ga', name: 'A用' },
  { id: 'gb', name: 'B用' },
];
const INPUTS: InputText[] = [
  { id: 'i1', title: 'one.md', text: 'アリス' },
  { id: 'i2', title: `two${RLO}md.txt`, text: 'ビル' },
];
const RULES: Rule[] = [
  rule('r1', 'アリス', { ga: 'あ', gb: 'い' }),
  rule('r2', 'ビル', { ga: 'び' }),
  rule('r3', 'x'.repeat(30), { ga: 'y' }, { order: 'seq' }),
];
const WORKSPACE = { inputs: INPUTS, groups: GROUPS, rules: RULES };

function collect(request: unknown): ConversionWorkerMessage[] {
  const messages: ConversionWorkerMessage[] = [];
  handleConversionRequest(request, (message) => messages.push(message));
  return messages;
}

describe('handleConversionRequest', () => {
  it('各パスの進みを知らせてから、結果を返す', () => {
    const messages = collect(WORKSPACE);
    const progress = messages.filter((message) => message.kind === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    const last = messages.at(-1);
    expect(last?.kind).toBe('done');
    if (last?.kind !== 'done') return;
    expect(last.result.groups[0]?.files[0]?.text).toBe('あ');
  });

  it('結果が上限を超えたら、どこで超えたかを知らせる', () => {
    const big = 'a'.repeat(1024);
    const rules = [
      rule('grow', '.+', { ga: '$&'.repeat(64) }, { regex: true, order: 'seq' }),
      rule('grow2', '.+', { ga: '$&'.repeat(64) }, { regex: true, order: 'seq' }),
      rule('grow3', '.+', { ga: '$&'.repeat(64) }, { regex: true, order: 'seq' }),
    ];
    // 1024 × 64 × 64 × 64 は上限を超える（3回目の展開の途中で止まる）。
    expect(1024 * 64 ** 3).toBeGreaterThan(MAX_CONVERSION_OUTPUT_CODE_UNITS);
    const messages = collect({
      inputs: [{ id: 'i', title: 'big.txt', text: big }],
      groups: [{ id: 'ga', name: 'A用' }],
      rules,
    });
    expect(messages.at(-1)).toEqual({
      kind: 'tooLarge',
      ruleId: 'grow3',
      groupId: 'ga',
      inputIndex: 0,
    });
  });

  it('入力の形でなければ、変換せずに失敗を返す', () => {
    expect(collect(null)).toEqual([{ kind: 'failed' }]);
    expect(collect({ inputs: [], groups: 'x', rules: [] })).toEqual([{ kind: 'failed' }]);
  });

  it('想定外の例外は外へ投げずに失敗を返し、原因は report に渡す', () => {
    const reported: unknown[] = [];
    const messages: ConversionWorkerMessage[] = [];
    handleConversionRequest(
      // 要素が壊れていると変換の途中で例外になる。
      { inputs: [null], groups: GROUPS, rules: [] },
      (message) => messages.push(message),
      (error) => reported.push(error),
    );
    expect(messages).toEqual([{ kind: 'failed' }]);
    expect(reported).toHaveLength(1);
  });

  it('report を渡さなくても失敗を返す', () => {
    expect(collect({ inputs: [null], groups: GROUPS, rules: [] })).toEqual([{ kind: 'failed' }]);
  });
});

describe('isConversionInput / isConversionWorkerMessage', () => {
  it('配列の揃った入力だけを受け付ける', () => {
    expect(isConversionInput(WORKSPACE)).toBe(true);
    expect(isConversionInput([])).toBe(false);
    expect(isConversionInput({ inputs: [], groups: [] })).toBe(false);
  });

  it('知っている種類のメッセージだけを受け付ける', () => {
    expect(isConversionWorkerMessage({ kind: 'failed' })).toBe(true);
    expect(isConversionWorkerMessage({ kind: 'other' })).toBe(false);
    expect(isConversionWorkerMessage('done')).toBe(false);
  });
});

describe('describeConversionStop', () => {
  it('止まったパスのグループ・ファイル・ルールの行と置換元を示す', () => {
    const text = describeConversionStop(
      { kind: 'stalled', ms: 30_000, progress: { groupIndex: 1, inputIndex: 0, ruleIds: ['r1'] } },
      WORKSPACE,
    );
    expect(text).toContain('「B用」の');
    expect(text).toContain('one.md で');
    expect(text).toContain('ルール 1 行目（置換元: アリス）');
    expect(text).toContain('30 秒');
  });

  it('同時に当てるまとまりは行をまとめて示し、長い置換元は先頭だけにする', () => {
    const simultaneous = describeConversionStop(
      {
        kind: 'stalled',
        ms: 30_000,
        progress: { groupIndex: 0, inputIndex: 0, ruleIds: ['r1', 'r2'] },
      },
      WORKSPACE,
    );
    expect(simultaneous).toContain('ルール 1・2 行目（同時に当てるまとまり）');
    const long = describeConversionStop(
      { kind: 'stalled', ms: 30_000, progress: { groupIndex: 0, inputIndex: 0, ruleIds: ['r3'] } },
      WORKSPACE,
    );
    expect(long).toContain(`置換元: ${'x'.repeat(20)}…`);
  });

  it('ファイル名の双方向制御文字は見える形にする', () => {
    const text = describeConversionStop(
      { kind: 'tooLarge', ruleId: 'r2', groupId: 'ga', inputIndex: 1 },
      WORKSPACE,
    );
    expect(text).toContain('⟨U+202E⟩');
    expect(text).toContain('ルール 2 行目（置換元: ビル）');
    expect(text).toContain('大きくなりすぎた');
  });

  it('グループが1つだけなら、グループ名は省く', () => {
    const text = describeConversionStop(
      { kind: 'stalled', ms: 30_000, progress: { groupIndex: 0, inputIndex: 0, ruleIds: ['r1'] } },
      { ...WORKSPACE, groups: [{ id: 'ga', name: 'A用' }] },
    );
    expect(text).not.toContain('A用');
    expect(text.startsWith('one.md で')).toBe(true);
  });

  it('進みが一度も届いていなければ、場所を示さずに知らせる', () => {
    expect(describeConversionStop({ kind: 'stalled', ms: 30_000, progress: null }, WORKSPACE)).toBe(
      '変換が 30 秒進まなかったため中止しました。もう一度変換してください。',
    );
  });

  it('知らないルール ID なら行を示さない', () => {
    const text = describeConversionStop(
      { kind: 'stalled', ms: 30_000, progress: { groupIndex: 9, inputIndex: 9, ruleIds: ['zz'] } },
      WORKSPACE,
    );
    expect(text.startsWith('ルールの置換')).toBe(true);
  });

  it('置換ではなく複製の合計で超えたときは、グループか入力を減らすよう案内する', () => {
    const text = describeConversionStop(
      { kind: 'tooLarge', ruleId: null, groupId: 'gb', inputIndex: 0 },
      WORKSPACE,
    );
    expect(text).toContain('グループか入力を減らして');
  });

  it('それ以外の失敗', () => {
    expect(describeConversionStop({ kind: 'failed' }, WORKSPACE)).toContain('変換に失敗しました');
  });
});
