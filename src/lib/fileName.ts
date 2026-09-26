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

/** 入力テキストのタイトルから出力ファイル名を決める。拡張子がなければ `.txt` を足す。 */
export function resolveFileNames(titles: readonly string[]): string[] {
  return dedupeNames(
    titles.map((title, index) => {
      const cleaned = sanitizeName(title ?? '', true) || `text-${index + 1}.txt`;
      return /\.[a-z0-9]+$/i.test(cleaned) ? cleaned : `${cleaned}.txt`;
    }),
  );
}

/** グループ名から ZIP 内のディレクトリ名を決める。 */
export function resolveDirNames(names: readonly string[]): string[] {
  return dedupeNames(
    names.map((name, index) => sanitizeName(name ?? '', false) || `group-${index + 1}`),
  );
}
