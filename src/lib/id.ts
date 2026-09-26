/**
 * 衝突しにくい短いIDを作る。永続化されるので人間が読める必要はない。
 *
 * 以前は `Math.random().toString(36).slice(2, 10)` を使っていたが、乱数が小さいと
 * 桁が足りず空文字や1文字を返し得た（実測: 0 → "", 0.5 → "i"）。ID が空になると
 * `[data-input-id=""]` のようなセレクタや `values[""]` が壊れるため、長さを保証する。
 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;

export function createId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

/** グループIDは `g` 始まりにして、ルールIDと目視で区別できるようにする。 */
export function createGroupId(): string {
  return `g${createId()}`;
}
