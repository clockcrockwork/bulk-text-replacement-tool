/** ブラウザ API に触る薄いラッパ。ここだけ副作用を持つのでテスト対象外にしている。 */

/** `Blob` をファイルとして保存させる。 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // すぐ revoke するとダウンロードが始まらないブラウザがあるので少し待つ。
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** クリップボードへコピーする。Clipboard API が使えない環境では隠し textarea にフォールバックする。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch {
      // これ以上打つ手はない。呼び出し側のトーストだけ出す。
    }
    textarea.remove();
  }
}

/** ダウンロードしたファイル名に使う `YYYYMMDD-HHmm`。 */
export function timestampForFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
