import type { ConversionResult, Group, InputText, Rule } from '../types';
import { MAX_CONVERSION_OUTPUT_CODE_UNITS } from './inputLimits';
import {
  type ConversionInput,
  ConversionOutputLimitError,
  type ConversionProgress,
  runConversion,
} from './replace';
import { revealUnsafeChars } from './revealText';

/**
 * 変換を Web Worker で走らせるときの、メッセージの形と止まったときの知らせ（issue #31）。
 *
 * 変換はメインスレッドで同期に走らせるとタブごと固まる。正規表現の破滅的なバックトラック
 * （`(a+)+$` を `aaaa…b` に当てる）は、始まってしまうと同じスレッドからは中断できない。
 * Worker に隔離し、進みが止まったら Worker ごと捨てる（`terminate`）。
 *
 * 正規表現のエンジンや構文はそのまま（RE2 などへの置き換え・構文の制限はしない）。
 * 書ける正規表現を変えると、利用者のルール表の意味が変わるため。
 */

/**
 * 1つのパス（同時適用のまとまり、または順次の1行）を1つのファイルに当てて、これだけ
 * 進みが無ければ止める。変換全体ではなくパスごとに数えるので、ファイルやルールが多いだけの
 * 長い変換は止めない。止まったパスがそのまま原因として示せる。
 */
export const CONVERSION_STALL_TIMEOUT_MS = 30_000;

/** Worker から届くメッセージ。 */
export type ConversionWorkerMessage =
  | { kind: 'progress'; progress: ConversionProgress }
  | { kind: 'done'; result: ConversionResult }
  | {
      kind: 'tooLarge';
      ruleId: string | null;
      groupId: string | null;
      inputIndex: number | null;
    }
  | { kind: 'failed' };

/** 変換が完了せずに止まった理由。 */
export type ConversionStop =
  /** パスの進みが `ms` のあいだ無かった。`progress` は最後に始めたパス。 */
  | { kind: 'stalled'; ms: number; progress: ConversionProgress | null }
  | { kind: 'tooLarge'; ruleId: string | null; groupId: string | null; inputIndex: number | null }
  | { kind: 'failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Worker が受け取った値が変換の入力か。送るのは同じアプリのメインスレッドだが、
 * `MessageEvent.data` は型が無いので、配列であることだけ確かめてから使う。
 */
export function isConversionInput(value: unknown): value is ConversionInput {
  return (
    isRecord(value) &&
    Array.isArray(value.inputs) &&
    Array.isArray(value.groups) &&
    Array.isArray(value.rules)
  );
}

const MESSAGE_KINDS: ReadonlySet<unknown> = new Set(['progress', 'done', 'tooLarge', 'failed']);

/** メインスレッドが受け取った値が Worker のメッセージか（種類だけを見る）。 */
export function isConversionWorkerMessage(value: unknown): value is ConversionWorkerMessage {
  return isRecord(value) && MESSAGE_KINDS.has(value.kind);
}

/**
 * Worker の中で1回の変換を行い、進みと結果を `post` で返す。例外は外へ出さずに
 * メッセージにする（Worker の外では例外の中身を受け取れない）。想定外の例外は
 * `report` に渡す（原因を追えるように、Worker 側でコンソールへ出す）。
 */
export function handleConversionRequest(
  request: unknown,
  post: (message: ConversionWorkerMessage) => void,
  report: (error: unknown) => void = () => {},
): void {
  if (!isConversionInput(request)) {
    post({ kind: 'failed' });
    return;
  }
  try {
    const result = runConversion(request, {
      maxOutputCodeUnits: MAX_CONVERSION_OUTPUT_CODE_UNITS,
      onPass: (progress) => post({ kind: 'progress', progress }),
    });
    post({ kind: 'done', result });
  } catch (error) {
    if (error instanceof ConversionOutputLimitError) {
      post({
        kind: 'tooLarge',
        ruleId: error.ruleId,
        groupId: error.groupId,
        inputIndex: error.inputIndex,
      });
      return;
    }
    report(error);
    post({ kind: 'failed' });
  }
}

/** 長い置換元は先頭だけ見せる（知らせの文が読めなくなる）。 */
const SOURCE_PREVIEW_LENGTH = 20;

function previewSource(src: string): string {
  const chars = [...src];
  const head = chars.slice(0, SOURCE_PREVIEW_LENGTH).join('');
  return revealUnsafeChars(chars.length > SOURCE_PREVIEW_LENGTH ? `${head}…` : head);
}

/** ルール表の行（1始まり）と置換元で、ルールを指す。 */
function describeRules(rules: readonly Rule[], ruleIds: readonly string[]): string {
  const found = ruleIds
    .map((id) => {
      const index = rules.findIndex((rule) => rule.id === id);
      const rule = rules[index];
      return rule ? { row: index + 1, src: rule.src } : null;
    })
    .filter((item) => item !== null);
  const [first] = found;
  if (!first) return 'ルール';
  if (found.length === 1) return `ルール ${first.row} 行目（置換元: ${previewSource(first.src)}）`;
  return `ルール ${found.map((item) => item.row).join('・')} 行目（同時に当てるまとまり）`;
}

/** 「グループ」の「ファイル」。分からない部分は省く。 */
function describePlace(
  groups: readonly Group[],
  inputs: readonly InputText[],
  group: Group | undefined,
  inputIndex: number | null,
): string {
  const input = inputIndex === null ? undefined : inputs[inputIndex];
  const parts: string[] = [];
  if (group && groups.length > 1) parts.push(`「${revealUnsafeChars(group.name)}」の`);
  if (input) parts.push(`${revealUnsafeChars(input.title || '無題')} で`);
  return parts.join('');
}

/** 止まった理由を、利用者向けの文にする。 */
export function describeConversionStop(stop: ConversionStop, workspace: ConversionInput): string {
  const { inputs, groups, rules } = workspace;
  switch (stop.kind) {
    case 'stalled': {
      const seconds = Math.round(stop.ms / 1000);
      const { progress } = stop;
      if (!progress) {
        return `変換が ${seconds} 秒進まなかったため中止しました。もう一度変換してください。`;
      }
      const place = describePlace(groups, inputs, groups[progress.groupIndex], progress.inputIndex);
      return (
        `${place}${describeRules(rules, progress.ruleIds)}の置換が ${seconds} 秒終わらなかったため、変換を中止しました。` +
        '正規表現が、入れ子の繰り返し（例: (a+)+）のような極端に時間のかかる形になっていないか確認してください。'
      );
    }
    case 'tooLarge': {
      const group = groups.find((item) => item.id === stop.groupId);
      if (stop.ruleId === null) {
        return '変換結果の合計が大きくなりすぎたため、変換を中止しました。結果はグループの数だけ作られるので、グループか入力を減らしてください。';
      }
      return (
        `${describePlace(groups, inputs, group, stop.inputIndex)}${describeRules(rules, [stop.ruleId])}の置換で結果が大きくなりすぎたため、変換を中止しました。` +
        '置換先での $& の繰り返しや、順次適用で同じ文字列を何度も増やす形になっていないか確認してください。'
      );
    }
    case 'failed':
      return '変換に失敗しました。もう一度変換してください。';
  }
}
