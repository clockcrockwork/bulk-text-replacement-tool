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
 * 行を正規表現で見るのではなく、YAML として読んで「実際の mapping key が uses」の箇所を
 * 見る。行単位だと、引用したキー（`"uses":`）やフロー形式で固定していない Action を
 * すり抜けさせ、逆に `run: |` やヒアドキュメントの本文にある `uses:` を Action と取り違える。
 */
import { isAlias, isScalar, LineCounter, parseAllDocuments, Scalar, visit } from 'yaml';

/** @typedef {{ line: number; message: string }} PinProblem */

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
  /** @param {number} offset */
  const lineAt = (offset) => lineCounter.linePos(offset).line;

  // 空のファイルは EmptyStream（文書の配列ではない）になる。見るものが無いので問題も無い。
  if (!Array.isArray(documents)) return problems;

  for (const document of documents) {
    for (const error of document.errors) {
      problems.push({
        line: lineAt(error.pos[0]),
        message: `YAML として読めない（${error.code}）`,
      });
    }
    if (document.errors.length > 0) continue;

    visit(document, {
      Pair(_, pair) {
        const { key, value } = pair;
        // キーに別名（`*name`）を使うと、中身を解決しないと uses かどうか分からない。
        // 使う理由が無い書き方なので、読めないものとして落とす。
        if (isAlias(key)) {
          const line = key.range ? lineAt(key.range[0]) : 0;
          problems.push({ line, message: 'キーに別名（*anchor）を使わない' });
          return;
        }
        if (!isScalar(key) || key.value !== 'uses') return;
        const keyLine = key.range ? lineAt(key.range[0]) : 0;

        if (isAlias(value)) {
          problems.push({ line: keyLine, message: 'uses: に別名（*anchor）を使わない' });
          return;
        }
        if (
          !isScalar(value) ||
          typeof value.value !== 'string' ||
          !value.range ||
          !INLINE_SCALAR_TYPES.has(value.type ?? '')
        ) {
          problems.push({ line: keyLine, message: UNREADABLE });
          return;
        }

        const ref = value.value;
        const line = lineAt(value.range[0]);
        // 同じリポジトリの中の Action は、このリポジトリの差分として見えるので固定しなくてよい。
        if (ref.startsWith('./')) return;
        if (!PINNED.test(ref)) {
          problems.push({ line, message: `${ref} がコミット SHA（40 桁）で固定されていない` });
          return;
        }
        const end = value.range[1];
        const lineEnd = source.indexOf('\n', end);
        const rest = source.slice(end, lineEnd === -1 ? undefined : lineEnd);
        const comment = TRAILING_COMMENT.exec(rest)?.[1] ?? '';
        if (!VERSION_COMMENT.test(comment)) {
          problems.push({ line, message: `${ref} の後ろに版の注記（例: # v7.0.1）が無い` });
        }
      },
    });
  }
  return problems;
}
