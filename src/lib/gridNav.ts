/**
 * ルール表のキーボード移動。DOM に触らず「次にどこへ行くか」だけを決める純粋関数。
 * 実際のフォーカス移動と行追加は呼び出し側が行う。
 */

export interface GridNavContext {
  key: string;
  shiftKey: boolean;
  /** 現在のセル位置。列0は置換元、列1以降が各グループ。 */
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** カード表示か。表表示では左右移動、カード表示では上下＝直列移動になる。 */
  cards: boolean;
  /** キャレットが入力欄の先頭にあるか（表表示の ← 判定に使う）。 */
  atStart: boolean;
  /** キャレットが入力欄の末尾にあるか（表表示の → 判定に使う）。 */
  atEnd: boolean;
}

export type GridNavResult =
  | { type: 'none' }
  | { type: 'move'; row: number; col: number }
  /** 末尾で移動しようとした場合に、行を足してそこへ移る。 */
  | { type: 'append'; col: number };

export function resolveGridNav(ctx: GridNavContext): GridNavResult {
  const { key, shiftKey, row, col, rows, cols, cards, atStart, atEnd } = ctx;
  const linear = row * cols + col;
  const last = rows * cols - 1;

  /** 表を1本のセル列とみなして前後に移動する。範囲外なら none。 */
  const step = (delta: number): GridNavResult => {
    const target = linear + delta;
    if (target < 0 || target > last) return { type: 'none' };
    return { type: 'move', row: Math.floor(target / cols), col: target % cols };
  };

  switch (key) {
    case 'Tab': {
      if (shiftKey) return step(-1);
      const next = step(1);
      return next.type === 'none' ? { type: 'append', col: 0 } : next;
    }
    case 'Enter': {
      if (cards) {
        if (shiftKey) return step(-1);
        const next = step(1);
        return next.type === 'none' ? { type: 'append', col: 0 } : next;
      }
      if (shiftKey) return row > 0 ? { type: 'move', row: row - 1, col } : { type: 'none' };
      return row < rows - 1 ? { type: 'move', row: row + 1, col } : { type: 'append', col };
    }
    case 'ArrowDown':
      if (cards) return step(1);
      return row < rows - 1 ? { type: 'move', row: row + 1, col } : { type: 'none' };
    case 'ArrowUp':
      if (cards) return step(-1);
      return row > 0 ? { type: 'move', row: row - 1, col } : { type: 'none' };
    case 'ArrowRight':
      return !cards && atEnd && col < cols - 1
        ? { type: 'move', row, col: col + 1 }
        : { type: 'none' };
    case 'ArrowLeft':
      return !cards && atStart && col > 0 ? { type: 'move', row, col: col - 1 } : { type: 'none' };
    default:
      return { type: 'none' };
  }
}
