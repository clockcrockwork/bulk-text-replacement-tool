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

/**
 * クリップボードへコピーする。Clipboard API が使えない環境では隠し textarea に
 * フォールバックする。
 *
 * **成否を返す。** 以前は常に正常終了していたため、Safari の権限制限などで実際には
 * コピーできていなくても「コピーしました」と出ていた。`execCommand('copy')` は
 * 失敗時に例外ではなく `false` を返すことがあるので、戻り値も見る。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API が無い／拒否された場合の保険。
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}
