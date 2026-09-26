import type {
  ConversionResult,
  Group,
  InputText,
  ResultFile,
  ResultGroup,
  Rule,
  Segment,
} from '../types';
import { resolveDirNames, resolveFileNames } from './fileName';
import { type CompiledRule, compileRule, expandReplacement } from './regex';

/** 1グループ・1パスぶんの置換指示。置換先が空のルールは含まれない。 */
interface BatchItem {
  ruleId: string;
  re: RegExp;
  replacement: string;
  isRegex: boolean;
}

/** 同時適用（`sim`）でまとめられた1回ぶんのパス。 */
type Batch = BatchItem[];

/**
 * ルール列を適用パスに畳み込む。
 * 連続する `sim` 行は1つのパスにまとめ、`seq` 行は単独のパスとして切り出す。
 * 置換先が空・置換元が空・正規表現エラーの行は落ちる（＝そのグループでは何もしない）。
 */
export function buildBatches(
  rules: readonly Rule[],
  compiled: readonly CompiledRule[],
  groupId: string,
): Batch[] {
  const batches: Batch[] = [];
  let current: Batch | null = null;

  rules.forEach((rule, index) => {
    const result = compiled[index];
    const replacement = rule.values[groupId];
    const item: BatchItem | null =
      result?.kind === 'ok' && replacement !== undefined && replacement !== ''
        ? { ruleId: rule.id, re: result.re, replacement, isRegex: rule.regex }
        : null;

    if (rule.order === 'seq') {
      current = null;
      if (item) batches.push([item]);
      return;
    }
    if (!item) return;
    if (!current) {
      current = [];
      batches.push(current);
    }
    current.push(item);
  });

  return batches;
}

/** 1つの一致候補。同じ位置で競合したときの優先順位付けに `order` を使う。 */
interface Candidate {
  start: number;
  end: number;
  item: BatchItem;
  match: RegExpExecArray;
  order: number;
}

/**
 * 断片列に1パスぶんの置換を適用する。
 *
 * 同じパス内のルールは「同時」に走る: 元テキストを一度だけ走査して候補を集め、
 * 開始位置が早い順 → 一致が長い順 → ルール定義順で採用する。
 * 置換で生まれたテキストは同じパス内では再走査しないので、ルールが連鎖することはない。
 *
 * @param hits ルールIDごとの置換件数。呼び出し側のカウンタを破壊的に更新する。
 * @returns 新しい断片列と、このパスでの置換件数。
 */
export function applyBatch(
  segments: readonly Segment[],
  batch: Batch,
  hits: Record<string, number>,
): { segments: Segment[]; hits: number } {
  const out: Segment[] = [];
  let total = 0;

  for (const segment of segments) {
    const text = segment.text;
    const candidates: Candidate[] = [];

    batch.forEach((item, order) => {
      item.re.lastIndex = 0;
      let match = item.re.exec(text);
      while (match !== null) {
        if (match[0].length === 0) {
          // 空一致は無限ループになるので1文字進めて読み飛ばす。
          item.re.lastIndex += 1;
        } else {
          candidates.push({
            start: match.index,
            end: match.index + match[0].length,
            item,
            match,
            order,
          });
        }
        match = item.re.exec(text);
      }
    });

    if (candidates.length === 0) {
      out.push(segment);
      continue;
    }

    candidates.sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order,
    );

    let pos = 0;
    for (const candidate of candidates) {
      if (candidate.start < pos) continue; // 採用済みの範囲と重なる候補は捨てる。
      if (candidate.start > pos) {
        out.push({ text: text.slice(pos, candidate.start), hit: segment.hit });
      }
      const replaced = candidate.item.isRegex
        ? expandReplacement(candidate.item.replacement, candidate.match)
        : candidate.item.replacement;
      if (replaced) out.push({ text: replaced, hit: true });
      hits[candidate.item.ruleId] = (hits[candidate.item.ruleId] ?? 0) + 1;
      total += 1;
      pos = candidate.end;
    }
    if (pos < text.length) out.push({ text: text.slice(pos), hit: segment.hit });
  }

  return { segments: out, hits: total };
}

/** 隣り合う同種（ヒット／非ヒット）の断片を1つにまとめ、空断片を落とす。 */
export function mergeSegments(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out[out.length - 1];
    if (last && last.hit === segment.hit) {
      last.text += segment.text;
    } else {
      out.push({ ...segment });
    }
  }
  return out;
}

export interface ConversionInput {
  inputs: readonly InputText[];
  groups: readonly Group[];
  rules: readonly Rule[];
}

/**
 * 全入力 × 全グループの変換を実行する。副作用はなく、同じ入力なら常に同じ結果を返す
 * （`at` のみ実行時刻）。
 */
export function runConversion({ inputs, groups, rules }: ConversionInput): ConversionResult {
  const compiled = rules.map((rule) => compileRule(rule));
  const fileNames = resolveFileNames(inputs.map((input) => input.title));
  const dirNames = resolveDirNames(groups.map((group) => group.name));
  const hitsByGroupRule: Record<string, Record<string, number>> = {};

  const resultGroups: ResultGroup[] = groups.map((group, groupIndex) => {
    // 置換元が入っている行は、0件でもヒット数を表示したいので先に 0 で埋める。
    const hits: Record<string, number> = {};
    for (const rule of rules) {
      if (rule.src) hits[rule.id] = 0;
    }
    hitsByGroupRule[group.id] = hits;

    const batches = buildBatches(rules, compiled, group.id);
    const dir = dirNames[groupIndex] ?? `group-${groupIndex + 1}`;

    const files: ResultFile[] = inputs.map((input, inputIndex) => {
      let segments: Segment[] = [{ text: input.text, hit: false }];
      let fileHits = 0;
      for (const batch of batches) {
        const applied = applyBatch(segments, batch, hits);
        segments = applied.segments;
        fileHits += applied.hits;
      }
      segments = mergeSegments(segments);
      return {
        title: fileNames[inputIndex] ?? `text-${inputIndex + 1}.txt`,
        text: segments.map((segment) => segment.text).join(''),
        segments,
        hits: fileHits,
      };
    });

    return {
      id: group.id,
      name: group.name || dir,
      dir,
      files,
      hits: files.reduce((sum, file) => sum + file.hits, 0),
    };
  });

  return { at: new Date(), groups: resultGroups, hitsByGroupRule };
}
