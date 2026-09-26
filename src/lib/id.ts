/** 衝突しにくい短いIDを作る。永続化されるので人間が読める必要はない。 */
export function createId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** グループIDは `g` 始まりにして、ルールIDと目視で区別できるようにする。 */
export function createGroupId(): string {
  return `g${createId()}`;
}
