/**
 * ファイル名・ディレクトリ名から、OS やアーカイバが嫌う文字を落とす。
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
    .join('/');
}

/**
 * 重複する名前に ` (2)`, ` (3)` … を付けて一意にする。拡張子は末尾に残す。
 * 入力順を保った配列を返す。
 */
export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name);
    if (count === undefined) {
      seen.set(name, 1);
      return name;
    }
    const parts = /^(.*?)(\.[^./]+)?$/.exec(name);
    const base = parts?.[1] ?? name;
    const ext = parts?.[2] ?? '';
    let next = count + 1;
    seen.set(name, next);
    let candidate = `${base} (${next})${ext}`;
    while (seen.has(candidate)) {
      next += 1;
      candidate = `${base} (${next})${ext}`;
    }
    seen.set(candidate, 1);
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
