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

/**
 * 外から来た ID（保存データ・作業データ）を、そのまま使ってよいか。
 *
 * ID は `rule.values` や置換件数の集計など、普通のオブジェクトの辞書のキーに使う。
 * `__proto__` `constructor` `toString` のように、普通のオブジェクトが継承している
 * プロパティ名と同じだと、書いたつもりの値が入らず（`__proto__` への代入は無視される）、
 * 読むと継承した関数やオブジェクトが返る。その値が置換先として描画・変換に渡ると
 * 例外になり、保存データに残っている以上、起動するたびに落ちる。
 *
 * 特定の名前を並べて断るのではなく、継承しているプロパティ名すべてと衝突しないことを
 * 条件にする（将来プロパティが増えても抜けない）。このアプリが作る ID（`createId`）は
 * 小文字英数字だけなので、常に満たす。
 */
export function isUsableId(id: string): boolean {
  return id !== '' && !(id in Object.prototype);
}
