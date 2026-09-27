import { ACCEPTED_EXTENSIONS } from './inputFiles';

/**
 * 既に使われている名前なら ` (2)` `(3)` … を足して一意にする。
 *
 * 表の取り込み・グループの追加・作業データの読み込みで同じ規則を使う。
 * 別々に組むと、経路によって同名が残ったり残らなかったりする。
 */
export function uniqueName(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) return name;
  let suffix = 2;
  while (used.has(`${name} (${suffix})`)) suffix += 1;
  return `${name} (${suffix})`;
}

/**
 * Windows の予約デバイス名。拡張子が付いていても開けないので避ける。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 1階層ぶんの名前を、どの OS でも扱える形に均す。 */
function sanitizeSegment(segment: string): string {
  // 末尾のドットと空白は Windows で黙って落とされ、別名になってしまう。
  const trimmed = segment.replace(/[. ]+$/, '');
  if (!trimmed) return '';
  const base = trimmed.split('.')[0] ?? '';
  return WINDOWS_RESERVED.test(base) ? `_${trimmed}` : trimmed;
}

/**
 * ファイル名・ディレクトリ名から、OS やアーカイバが嫌う文字と形を落とす。
 * `allowSlash` が false のとき `/` も潰す（ディレクトリ名として1階層に収めるため）。
 */
export function sanitizeName(name: string, allowSlash: boolean): string {
  const forbidden = allowSlash ? /[\\:*?"<>|]/g : /[\\/:*?"<>|]/g;
  const cleaned = name.replace(forbidden, '_').trim();
  // `.` と `..` を落とす。これが残ると ZIP のエントリ名が `A用/../../evil.txt` のように
  // 展開先を抜け出す形になり得る（Zip Slip）。空の区切りもここで消える。
  return cleaned
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(sanitizeSegment)
    .filter((segment) => segment !== '')
    .join('/');
}

/**
 * 重複する名前に ` (2)`, ` (3)` … を付けて一意にする。拡張子は末尾に残す。
 * 入力順を保った配列を返す。
 *
 * 比較は大文字小文字を無視する。ZIP の中では別エントリでも、macOS や Windows の
 * ように大小を区別しないファイルシステムへ展開すると `A.txt` と `a.txt` が衝突するため。
 */
export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key);
    if (count === undefined) {
      seen.set(key, 1);
      return name;
    }
    const parts = /^(.*?)(\.[^./]+)?$/.exec(name);
    const base = parts?.[1] ?? name;
    const ext = parts?.[2] ?? '';
    let next = count + 1;
    seen.set(key, next);
    let candidate = `${base} (${next})${ext}`;
    while (seen.has(candidate.toLowerCase())) {
      next += 1;
      candidate = `${base} (${next})${ext}`;
    }
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

/**
 * 名前の末尾が、このツールが中身を保証している拡張子か。
 *
 * 判定に使うのは取り込みと同じ一覧。ここを別に持つと、入力で受け付ける形式と
 * 出力で名乗る形式が静かにずれる。
 */
function hasGuaranteedExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 入力テキストのタイトルから出力ファイル名を決める。
 *
 * タイトルは**ファイル名であってパスではない**ので `/` は潰す。許すと ZIP の中だけ
 * 階層になり、個別保存では末尾だけが使われる、という食い違いが起きる。
 *
 * 中身は常に UTF-8 のプレーンテキストで、`.md` と書いても Markdown へ変換はしない。
 * そのため保証していない拡張子（`.html` など）はそのままにせず `.txt` を足して
 * `title.html.txt` にする。削って `title.txt` にしないのは、利用者が付けた名前を
 * 失わせないため。`.html` のまま出すと、展開後にブラウザが HTML として解釈し得る。
 *
 * 変えるのはファイル名だけで、本文・ルール・変換結果の文字列には一切触らない。
 */
export function resolveFileNames(titles: readonly string[]): string[] {
  return dedupeNames(
    titles.map((title, index) => {
      // 区切りは階層ではなく名前の一部として残すが、`.` と `..` だけの断片は落とす。
      // 先に `_` へ置き換えてしまうと `../../evil.txt` が `.._.._evil.txt` になり、
      // 無害ではあるものの読めない名前が残る。
      const flattened = (title ?? '')
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
        .join('_');
      const cleaned = sanitizeName(flattened, false) || `text-${index + 1}.txt`;
      return hasGuaranteedExtension(cleaned) ? cleaned : `${cleaned}.txt`;
    }),
  );
}

/** グループ名から ZIP 内のディレクトリ名を決める。 */
export function resolveDirNames(names: readonly string[]): string[] {
  return dedupeNames(
    names.map((name, index) => sanitizeName(name ?? '', false) || `group-${index + 1}`),
  );
}
