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
 * 元テキストの区間を新テキストへ複写するときに、掛かっていたハイライトを
 * 新しい座標へ移し替える関数を作る。
 *
 * 複写する区間は左から右へ単調に進むので、読み取り位置を保持して前回の続きから見る。
 * 毎回先頭から走査すると「候補数 × 範囲数」の総当たりになり、置換の多い原稿で
 * 二乗に効く（32,000 置換で約1.9秒かかっていた）。
 */
function createRangeCarrier(
  source: readonly HitRange[],
): (from: number, to: number, newStart: number, out: HitRange[]) => void {
  let cursor = 0;
  return (from, to, newStart, out) => {
    // from より手前で終わる範囲は、これ以降のどの区間にも掛からないので読み飛ばす。
    while (cursor < source.length) {
      const range = source[cursor];
      if (!range || range.end > from) break;
      cursor += 1;
    }
    for (let i = cursor; i < source.length; i++) {
      const range = source[i];
      if (!range || range.start >= to) break; // 昇順なのでこれ以降は掛からない
      const start = Math.max(range.start, from);
      const end = Math.min(range.end, to);
      pushRange(out, newStart + (start - from), newStart + (end - from));
    }
  };
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

/**
 * 変換結果が上限（`MAX_CONVERSION_OUTPUT_CODE_UNITS`）を超えた。どのルールの置換で
 * 超えたかを持つ（`runConversion` がグループとファイルを添える）。`ruleId` が null なのは、
 * 置換で膨らんだのではなく、入力を多くのグループへ複製した合計が超えたとき。
 */
export class ConversionOutputLimitError extends Error {
  constructor(
    readonly ruleId: string | null,
    readonly groupId: string | null = null,
    readonly inputIndex: number | null = null,
  ) {
    super('変換結果が上限を超えました');
    this.name = 'ConversionOutputLimitError';
  }
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
 * 空一致の後に `lastIndex` を進める位置。ECMAScript の AdvanceStringIndex に当たる。
 *
 * 正規表現は常に `u` 付きなので、1 code unit だけ進めると補助面の文字（`😀` `𠮷`）の
 * サロゲートペアの途中を指し、エンジンが文字の先頭へ戻して同じ空一致を返し続ける
 * （`^` × `😀abc` で止まらなくなる）。コードポイント単位で進めて必ず前へ進ませる。
 * 対になっていないサロゲートは 1 code unit として進める。
 */
export function advanceStringIndex(text: string, index: number): number {
  if (index + 1 >= text.length) return index + 1;
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? index + 2 : index + 1;
}

/** 採用する順。開始が早い順 → 一致が長い順 → ルール定義順。 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order;
}

/**
 * ルールの次の一致（空一致は読み飛ばす）。`re.lastIndex` から続きを探すので、1つのルールの
 * 一致は、テキスト全体を先頭から走査したときと同じ並びで、開始位置の昇順に出てくる。
 */
function nextCandidate(text: string, item: BatchItem, order: number): Candidate | null {
  for (let match = item.re.exec(text); match !== null; match = item.re.exec(text)) {
    if (match[0].length > 0) {
      return { start: match.index, end: match.index + match[0].length, item, match, order };
    }
    // 空一致は無限ループになるので読み飛ばす。
    item.re.lastIndex = advanceStringIndex(text, item.re.lastIndex);
  }
  return null;
}

/**
 * バッチ内の全ルールの一致を、採用する順（`compareCandidates`）に1つずつ取り出す。
 *
 * 以前は全ルールの全一致を配列に集めてから並べ替えていた。1文字ごとに一致するルールなどで
 * 候補が入力の長さだけでき、出力の上限より先に一致の配列でメモリが膨らんでいた
 * （issue #31 のレビュー R4）。各ルールは一致を開始位置の昇順に出すので、ルールごとの
 * 「次の一致」だけをヒープに持って併合すれば、並べ替えた全候補と同じ順に取り出せる。
 * 持つのはルールの数だけ。読み飛ばす候補も含め、各ルールの一致を1回ずつ探す手間は同じ。
 */
function createCandidateStream(text: string, batch: Batch): () => Candidate | null {
  const heap: Candidate[] = [];
  const less = (i: number, j: number): boolean => {
    const a = heap[i];
    const b = heap[j];
    return a !== undefined && b !== undefined && compareCandidates(a, b) < 0;
  };
  const swap = (i: number, j: number): void => {
    const a = heap[i];
    const b = heap[j];
    if (a === undefined || b === undefined) return;
    heap[i] = b;
    heap[j] = a;
  };
  const push = (candidate: Candidate): void => {
    heap.push(candidate);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(i, parent)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = (): Candidate | null => {
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined) return null;
    if (heap.length === 0) return top;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && less(left, smallest)) smallest = left;
      if (right < heap.length && less(right, smallest)) smallest = right;
      if (smallest === i) break;
      swap(i, smallest);
      i = smallest;
    }
    return top;
  };

  batch.forEach((item, order) => {
    item.re.lastIndex = 0;
    const first = nextCandidate(text, item, order);
    if (first) push(first);
  });

  return () => {
    const candidate = pop();
    if (!candidate) return null;
    // 取り出したルールの次の一致を補充する。これで常に、各ルールの未採用の先頭が揃う。
    const following = nextCandidate(text, candidate.item, candidate.order);
    if (following) push(following);
    return candidate;
  };
}

/**
 * テキスト全体に1パスぶんの置換を適用する。
 *
 * 同じパス内のルールは「同時」に走る: このパスの開始時点のテキストを各ルールで一度だけ
 * 走査し、開始位置が早い順 → 一致が長い順 → ルール定義順で採用する。
 * 置換で生まれたテキストを同じパス内で再走査することはないので、ルールは連鎖しない。
 *
 * パスをまたぐ場合（順次適用や、順次を挟んだ次の同時パス）は、その時点の
 * テキスト全体が対象になる。そのため前のパスの置換結果と周囲の文字列にまたがる
 * 一致も拾える。
 *
 * @param hits ルールIDごとの置換件数。呼び出し側のカウンタを破壊的に更新する。
 * @param limit 新しいテキストの長さの上限（UTF-16 のコード単位）。置換で超えたら、
 *   組み立て終わるのを待たずに `ConversionOutputLimitError` で止める（膨らみきってから
 *   測ると、その前にタブが落ちる）。
 * @returns 新しいテキストと、このパスでの置換件数。
 */
export function applyBatch(
  marked: MarkedText,
  batch: Batch,
  hits: Record<string, number>,
  limit = Number.POSITIVE_INFINITY,
): { marked: MarkedText; hits: number } {
  const { text, ranges } = marked;
  const nextInOrder = createCandidateStream(text, batch);
  let candidate = nextInOrder();
  if (!candidate) return { marked, hits: 0 };

  let out = '';
  const outRanges: HitRange[] = [];
  const carry = createRangeCarrier(ranges);
  let pos = 0;
  let total = 0;
  let lastRuleId: string | null = null;
  /**
   * 上限を超えた。置換の前から超えている（入力をグループへ複製した合計で超えた）なら、
   * このパスのルールのせいにしない。
   */
  const overflow = (ruleId: string | null): never => {
    throw new ConversionOutputLimitError(text.length > limit ? null : ruleId);
  };

  for (; candidate !== null; candidate = nextInOrder()) {
    if (candidate.start < pos) continue; // 採用済みの範囲と重なる候補は捨てる
    if (candidate.start > pos) {
      carry(pos, candidate.start, out.length, outRanges);
      out += text.slice(pos, candidate.start);
    }
    // 組み立て済みの長さは減らないので、超えた時点で確定する。残りの部分は足さない
    // （同じパスの後ろの置換で縮むことがあり、見込みで止めると収まる変換まで止める）。
    // 参照の展開には残りの予算を渡し、展開の途中で超えたら組み立てさせない。
    const room = limit - out.length;
    const replaced = candidate.item.isRegex
      ? expandReplacement(candidate.item.replacement, candidate.match, room)
      : candidate.item.replacement;
    if (replaced === null || replaced.length > room) overflow(candidate.item.ruleId);
    if (replaced) {
      pushRange(outRanges, out.length, out.length + replaced.length);
      out += replaced;
    }
    hits[candidate.item.ruleId] = (hits[candidate.item.ruleId] ?? 0) + 1;
    lastRuleId = candidate.item.ruleId;
    total += 1;
    pos = candidate.end;
  }
  if (pos < text.length) {
    carry(pos, text.length, out.length, outRanges);
    out += text.slice(pos);
  }
  if (out.length > limit) overflow(lastRuleId);

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

/** 変換の進み。どのグループのどのファイルに、どのルール（同時適用のまとまり）を当てるか。 */
export interface ConversionProgress {
  groupIndex: number;
  inputIndex: number;
  /** これから当てるパスのルール ID（同時適用なら複数）。 */
  ruleIds: string[];
}

export interface ConversionOptions {
  /** 結果の本文の合計の上限（UTF-16 のコード単位）。超えたら `ConversionOutputLimitError`。 */
  maxOutputCodeUnits?: number;
  /**
   * 各パスを当てる直前に呼ぶ。止まったパス（破滅的なバックトラックなど）を特定するのに
   * 使うので、間引かずに毎回呼ぶ。
   */
  onPass?: (progress: ConversionProgress) => void;
}

/**
 * 全入力 × 全グループの変換を実行する。副作用はなく、同じ入力なら常に同じ結果を返す
 * （`at` のみ実行時刻）。
 */
export function runConversion(
  { inputs, groups, rules }: ConversionInput,
  { maxOutputCodeUnits = Number.POSITIVE_INFINITY, onPass }: ConversionOptions = {},
): ConversionResult {
  const compiled = rules.map((rule) => compileRule(rule));
  const fileNames = resolveFileNames(inputs.map((input) => input.title));
  // ZIP のディレクトリ名。画面のタブ名にもこれをそのまま使う。
  // 名前を生のまま出すと、同じ「A用」というタブが2つ並び、どちらがどのグループか
  // 分からないのに、ZIP の中では別ディレクトリ、という食い違いが起きる。
  const dirNames = resolveDirNames(groups.map((group) => group.name));
  const hitsByGroupRule: Record<string, Record<string, number>> = {};
  /** ここまでに作った結果の本文の長さの合計。 */
  let used = 0;

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
        onPass?.({ groupIndex, inputIndex, ruleIds: batch.map((item) => item.ruleId) });
        try {
          const applied = applyBatch(marked, batch, hits, maxOutputCodeUnits - used);
          marked = applied.marked;
          fileHits += applied.hits;
        } catch (error) {
          if (error instanceof ConversionOutputLimitError) {
            throw new ConversionOutputLimitError(error.ruleId, group.id, inputIndex);
          }
          throw error;
        }
      }
      // 置換が1件も無いファイルも、結果として複製を持つので数える。
      used += marked.text.length;
      if (used > maxOutputCodeUnits) {
        throw new ConversionOutputLimitError(null, group.id, inputIndex);
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
      name: dir,
      dir,
      files,
      hits: files.reduce((sum, file) => sum + file.hits, 0),
    };
  });

  return { at: new Date(), groups: resultGroups, hitsByGroupRule };
}
