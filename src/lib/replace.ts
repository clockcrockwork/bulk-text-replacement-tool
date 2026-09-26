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

/** 置換で生成された範囲（終端は含まない）。 */
interface HitRange {
  start: number;
  end: number;
}

/**
 * 置換途中のテキストと、そこまでに置換で生成された範囲。
 *
 * 以前は断片（Segment）の配列を持ち回っていたが、その形だと各パスが断片ごとに
 * 独立して走査されるため、「置換済みの文字列」と「その周囲」にまたがる一致を
 * 取りこぼしていた（順次適用が説明どおり動かない原因）。テキストは常に1本の
 * 文字列として保持し、ハイライト位置だけを範囲で覚えておく。
 */
export interface MarkedText {
  text: string;
  /** 開始位置の昇順・重なりなし・隣接は結合済み。 */
  ranges: HitRange[];
}

export function createMarkedText(text: string): MarkedText {
  return { text, ranges: [] };
}

/** 範囲列に1件足す。直前の範囲と隣接・重複していればまとめる。 */
function pushRange(ranges: HitRange[], start: number, end: number): void {
  if (end <= start) return;
  const last = ranges[ranges.length - 1];
  if (last && last.end >= start) {
    last.end = Math.max(last.end, end);
    return;
  }
  ranges.push({ start, end });
}

/**
 * 元テキストの `[from, to)` を新テキストの `newStart` 以降へ複写したときに、
 * その範囲に掛かっていたハイライトを新しい座標へ移し替える。
 */
function carryRanges(
  source: readonly HitRange[],
  from: number,
  to: number,
  newStart: number,
  out: HitRange[],
): void {
  for (const range of source) {
    if (range.end <= from) continue;
    if (range.start >= to) break; // 昇順なのでこれ以降は掛からない
    const start = Math.max(range.start, from);
    const end = Math.min(range.end, to);
    pushRange(out, newStart + (start - from), newStart + (end - from));
  }
}

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

/** バッチ内の全ルールで、テキスト全体から一致候補を集める。 */
function collectCandidates(text: string, batch: Batch): Candidate[] {
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
  // 開始が早い順 → 一致が長い順 → ルール定義順
  candidates.sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order,
  );
  return candidates;
}

/**
 * テキスト全体に1パスぶんの置換を適用する。
 *
 * 同じパス内のルールは「同時」に走る: このパスの開始時点のテキストを一度だけ走査して
 * 候補を集め、開始位置が早い順 → 一致が長い順 → ルール定義順で採用する。
 * 置換で生まれたテキストを同じパス内で再走査することはないので、ルールは連鎖しない。
 *
 * パスをまたぐ場合（順次適用や、順次を挟んだ次の同時パス）は、その時点の
 * テキスト全体が対象になる。そのため前のパスの置換結果と周囲の文字列にまたがる
 * 一致も拾える。
 *
 * @param hits ルールIDごとの置換件数。呼び出し側のカウンタを破壊的に更新する。
 * @returns 新しいテキストと、このパスでの置換件数。
 */
export function applyBatch(
  marked: MarkedText,
  batch: Batch,
  hits: Record<string, number>,
): { marked: MarkedText; hits: number } {
  const { text, ranges } = marked;
  const candidates = collectCandidates(text, batch);
  if (candidates.length === 0) return { marked, hits: 0 };

  let out = '';
  const outRanges: HitRange[] = [];
  let pos = 0;
  let total = 0;

  for (const candidate of candidates) {
    if (candidate.start < pos) continue; // 採用済みの範囲と重なる候補は捨てる
    if (candidate.start > pos) {
      carryRanges(ranges, pos, candidate.start, out.length, outRanges);
      out += text.slice(pos, candidate.start);
    }
    const replaced = candidate.item.isRegex
      ? expandReplacement(candidate.item.replacement, candidate.match)
      : candidate.item.replacement;
    if (replaced) {
      pushRange(outRanges, out.length, out.length + replaced.length);
      out += replaced;
    }
    hits[candidate.item.ruleId] = (hits[candidate.item.ruleId] ?? 0) + 1;
    total += 1;
    pos = candidate.end;
  }
  if (pos < text.length) {
    carryRanges(ranges, pos, text.length, out.length, outRanges);
    out += text.slice(pos);
  }

  return { marked: { text: out, ranges: outRanges }, hits: total };
}

/** ハイライト表示用の断片列に変換する。連結すると元のテキストと一致する。 */
export function toSegments({ text, ranges }: MarkedText): Segment[] {
  const segments: Segment[] = [];
  let pos = 0;
  for (const range of ranges) {
    if (range.start > pos) segments.push({ text: text.slice(pos, range.start), hit: false });
    segments.push({ text: text.slice(range.start, range.end), hit: true });
    pos = range.end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), hit: false });
  return segments;
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
      let marked = createMarkedText(input.text);
      let fileHits = 0;
      for (const batch of batches) {
        const applied = applyBatch(marked, batch, hits);
        marked = applied.marked;
        fileHits += applied.hits;
      }
      return {
        title: fileNames[inputIndex] ?? `text-${inputIndex + 1}.txt`,
        text: marked.text,
        segments: toSegments(marked),
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
