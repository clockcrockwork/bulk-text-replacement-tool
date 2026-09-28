import { ACCEPTED_EXTENSIONS } from './inputFiles';
import { UNSAFE_DISPLAY_CHARS } from './revealText';

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
 * 名前に残すと見た目と実体がずれる文字。
 *
 * - C0 / C1 制御文字: 改行やタブが ZIP のエントリ名やダウンロード名に入ると、
 *   一覧の表示が崩れたり、展開するツールによって扱いが割れたりする
 * - 双方向制御文字（LRM / RLM / ALM・埋め込み・上書き・隔離）: `a\u202egpj.md` が
 *   `adm.jpg` のように見え、拡張子を偽装できる（CVE-2021-42574 と同じ仕組み）
 * - 行区切り・段落区切り: 表示上は改行として扱われる
 * - 幅を持たない書式文字（ZWSP・単語結合子などの U+2060–206F・BOM・ソフトハイフン・
 *   行間注記 U+FFF9–FFFB・タグ文字 U+E0000–E007F）: `a\u200b.md` と `a.md` のように、
 *   見た目が同じなのに別のファイルになる（`scripts/checkText.mjs` がソースで禁じている文字と揃える）
 *
 * ZWNJ（U+200C）と ZWJ（U+200D）は残す。絵文字の合字やインド系の文字では、
 * 見た目と意味を持つ文字として使われる。
 *
 * 取り込んだ GitHub のパスは NUL と `/` 以外を何でも含み得るので、名前になる時点で潰す。
 * 見えない文字を黙って消すと別の名前に化けたことに気付けないため、`_` に置き換える。
 * 文字の集合は画面での可視化（`revealText.ts`）と共有する。見えていたのに出力では
 * `_` になった、またはその逆を作らないため。
 */
const INVISIBLE_OR_CONTROL = UNSAFE_DISPLAY_CHARS;

/**
 * ファイル名・ディレクトリ名から、OS やアーカイバが嫌う文字と形を落とす。
 * `allowSlash` が false のとき `/` も潰す（ディレクトリ名として1階層に収めるため）。
 *
 * 変えるのは名前だけで、本文・ルール・変換結果の文字列はここを通らない。
 */
export function sanitizeName(name: string, allowSlash: boolean): string {
  const forbidden = allowSlash ? /[\\:*?"<>|]/g : /[\\/:*?"<>|]/g;
  // 前後の空白・改行類（タブ・改行・U+2028/2029 など）は先に落とす（従来どおり）。中に残った
  // ものだけを `_` にする。ただし BOM（U+FEFF）は JS の trim が空白として扱うので、trim より
  // 先に置き換える。空白ではない見えない文字なので、前後にあっても黙って消さない。
  const cleaned = name
    .replace(/\ufeff/g, '_')
    .trim()
    .replace(INVISIBLE_OR_CONTROL, '_')
    .replace(forbidden, '_');
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
 * 展開先で同じ名前として扱われ得るかを比べるためのキー。
 *
 * 大文字小文字に加えて Unicode の正規化形も揃える。GitHub のパスは macOS 由来だと
 * NFD（`か` + 濁点）で来ることが多く、NFC の `が` と ZIP の中では別エントリになるが、
 * macOS（APFS）は正規化の差を無視して名前を比べるので、展開すると衝突して片方が失われ得る。
 * 揃えるのは比べるキーだけで、名前そのものは正規化しない（コードポイントの差も利用者の名前）。
 */
function collisionKey(name: string): string {
  return name.toLowerCase().normalize('NFC');
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
    const key = collisionKey(name);
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
    while (seen.has(collisionKey(candidate))) {
      next += 1;
      candidate = `${base} (${next})${ext}`;
    }
    seen.set(collisionKey(candidate), 1);
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
