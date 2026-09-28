/**
 * GitHub Actions の `uses:` がコミット SHA（40 桁）で固定されているかを判定する純粋関数。
 * ファイルを集めて呼ぶのは scripts/checkActionsPinned.mjs。
 *
 * タグ（`@v7`）は付け替えられる。Action のリポジトリが乗っ取られると、同じタグのまま
 * 中身を差し替えられ、次の CI からそのコードが走る（tj-actions/changed-files の事例）。
 * SHA なら、Dependabot の PR を通して差分を見てからでないと中身が変わらない。
 *
 * SHA の後ろには `# v7.0.1` のように版を書く。人が読めるようにするためと、Dependabot が
 * この注記を見て SHA と一緒に書き換えるため（注記が無いと版の対応が追えなくなる）。
 *
 * 行を正規表現で見るのではなく、YAML として読んで Action を参照する位置の `uses` を見る。
 * 行単位だと、引用したキー（`"uses":`）やフロー形式で固定していない Action を
 * すり抜けさせ、逆に `run: |` やヒアドキュメントの本文にある `uses:` を Action と取り違える。
 *
 * 見る位置は GitHub が Action / 再利用ワークフローとして解釈するところだけに絞る。
 * - ワークフロー: `jobs.<id>.steps[*].uses` と、再利用ワークフローの呼び出し `jobs.<id>.uses`
 * - composite action: `runs.steps[*].uses`
 * どこでも `uses` という key を見ると、Action の入力（`with.uses`）や `env.uses`・
 * `inputs.uses` のような、参照ではない値まで落としてしまう。
 *
 * 位置で絞る代わりに、そこへ至る道筋を別の書き方で隠させない。ジョブ・steps・ステップが
 * 別名（`*anchor`）なら参照先を解決して見る。キーの別名とマージキー（`<<`）は、
 * どの key が効くかが読み手と GitHub で食い違い得るので、読めないものとして落とす。
 */
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, Scalar } from 'yaml';

/** @typedef {{ line: number; message: string }} PinProblem */
/** @typedef {import('yaml').Document.Parsed} ParsedDocument */
/** @typedef {import('yaml').YAMLMap} YAMLMap */

const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+(?:\.\d+)*$/;
// 値の後ろ（同じ行）にある注記。フロー形式では `}` や `,` を挟むことがある。
const TRAILING_COMMENT = /^[^#]*?\s#\s*(.*?)\s*$/;

// Dependabot が版の注記と一緒に書き換えられるのは、1 行に収まる書き方だけ。
// 折り返し（`>-` / `|`）は注記の位置が定まらないので読めない書き方として落とす。
const INLINE_SCALAR_TYPES = new Set([Scalar.PLAIN, Scalar.QUOTE_SINGLE, Scalar.QUOTE_DOUBLE]);

const UNREADABLE = 'uses: を読めない書き方（1 行の `uses: owner/repo@<SHA> # vX.Y.Z` で書く）';

/**
 * ワークフロー / action.yml の本文を受け取り、固定されていない `uses:` を返す。
 * YAML として読めないときも、見えていない箇所を通さないために問題として返す。
 *
 * @param {string} source
 * @returns {PinProblem[]}
 */
export function findPinProblems(source) {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(source, { lineCounter, prettyErrors: false });
  /** @type {PinProblem[]} */
  const problems = [];
  // 同じアンカーを何か所から参照しても、定義の位置で 1 回だけ知らせる。
  const seen = new Set();
  /** @param {{ range?: readonly number[] | null | undefined } | null | undefined} node */
  const lineOf = (node) =>
    node?.range?.[0] === undefined ? 0 : lineCounter.linePos(node.range[0]).line;
  /** @param {number} line @param {string} message */
  const report = (line, message) => {
    const key = `${line}\n${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ line, message });
  };

  // 空のファイルは EmptyStream（文書の配列ではない）になる。見るものが無いので問題も無い。
  if (!Array.isArray(documents)) return problems;

  for (const document of /** @type {ParsedDocument[]} */ (documents)) {
    for (const error of document.errors) {
      report(lineCounter.linePos(error.pos[0]).line, `YAML として読めない（${error.code}）`);
    }
    if (document.errors.length > 0) continue;

    /** @param {unknown} node */
    const deref = (node) => (isAlias(node) ? node.resolve(document) : node);

    /**
     * mapping の key に別名・マージキーがあれば知らせ、そうでない組だけを返す。
     * どちらも、その mapping で何が効いているかが読み手と GitHub で食い違い得る。
     * 構造をたどる mapping（トップ・jobs・ジョブ・runs・ステップ）はすべてここを通す
     * （1 か所でも直接 items を回すと、そこだけマージキーで中身を持ち込める）。
     * @param {YAMLMap} map
     */
    const plainPairs = (map) =>
      map.items.filter((pair) => {
        if (isAlias(pair.key)) {
          report(lineOf(pair.key), 'キーに別名（*anchor）を使わない');
          return false;
        }
        if (isScalar(pair.key) && pair.key.value === '<<') {
          report(lineOf(pair.key), 'マージキー（<<）を使わない');
          return false;
        }
        return true;
      });

    /**
     * @param {YAMLMap} map
     * @param {string} name
     */
    const pairOf = (map, name) =>
      plainPairs(map).find((pair) => isScalar(pair.key) && pair.key.value === name);

    /** @param {YAMLMap} map ステップ、または再利用ワークフローを呼ぶジョブ */
    const checkUses = (map) => {
      const pair = pairOf(map, 'uses');
      if (!pair) return;
      const keyLine = lineOf(/** @type {{ range?: number[] }} */ (pair.key));
      const { value } = pair;
      if (isAlias(value)) {
        report(keyLine, 'uses: に別名（*anchor）を使わない');
        return;
      }
      if (
        !isScalar(value) ||
        typeof value.value !== 'string' ||
        !value.range ||
        !INLINE_SCALAR_TYPES.has(value.type ?? '')
      ) {
        report(keyLine, UNREADABLE);
        return;
      }

      const ref = value.value;
      const line = lineOf(value);
      // 同じリポジトリの中の Action は、このリポジトリの差分として見えるので固定しなくてよい。
      if (ref.startsWith('./')) return;
      if (!PINNED.test(ref)) {
        report(line, `${ref} がコミット SHA（40 桁）で固定されていない`);
        return;
      }
      const end = value.range[1];
      const lineEnd = source.indexOf('\n', end);
      const rest = source.slice(end, lineEnd === -1 ? undefined : lineEnd);
      const comment = TRAILING_COMMENT.exec(rest)?.[1] ?? '';
      if (!VERSION_COMMENT.test(comment)) {
        report(line, `${ref} の後ろに版の注記（例: # v7.0.1）が無い`);
      }
    };

    /** @param {YAMLMap} owner `steps` を持つジョブ、または composite action の `runs` */
    const checkSteps = (owner) => {
      const pair = pairOf(owner, 'steps');
      if (!pair) return;
      const steps = deref(pair.value);
      if (steps == null || (isScalar(steps) && steps.value == null)) return;
      if (!isSeq(steps)) {
        report(
          lineOf(/** @type {{ range?: number[] }} */ (pair.key)),
          'steps が配列として読めない',
        );
        return;
      }
      for (const item of steps.items) {
        const step = deref(item);
        if (isMap(step)) checkUses(step);
        else
          report(
            lineOf(/** @type {{ range?: number[] }} */ (item)),
            'ステップが mapping として読めない',
          );
      }
    };

    const root = deref(document.contents);
    if (!isMap(root)) continue;

    const jobs = deref(pairOf(root, 'jobs')?.value);
    if (isMap(jobs)) {
      for (const pair of plainPairs(jobs)) {
        const job = deref(pair.value);
        if (!isMap(job)) continue;
        checkUses(job);
        checkSteps(job);
      }
    }

    const runs = deref(pairOf(root, 'runs')?.value);
    if (isMap(runs)) checkSteps(runs);
  }
  return problems;
}
