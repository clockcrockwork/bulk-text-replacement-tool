import type { JSX } from 'react';
import { formatCellPreview, isMultiline } from '../lib/format';
import { multilineCellLabel } from './ruleTypes';

interface RuleCellProps {
  className: string;
  /** キーボード移動用のセル座標（`data-cell`）。 */
  cell: string;
  value: string;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  onEdit: () => void;
}

/**
 * ルール表の1セル。ふだんは1行入力、改行を含む値のときだけ要約表示のボタンになる。
 *
 * 改行入りの値を `<input>` に載せると、ブラウザが改行を落とすため、一度触っただけで
 * 値が壊れる。表の一覧性（1行1ルール）は保ったまま、複数行の実体は専用のエディタで
 * 編集する。要約表示は `一行目… [複数行]` の形にして、改行位置を詰め込んで見せたりはしない。
 */
export function RuleCell({
  className,
  cell,
  value,
  label,
  placeholder,
  onChange,
  onEdit,
}: RuleCellProps): JSX.Element {
  if (isMultiline(value)) {
    return (
      <button
        type="button"
        className={`cell-input cell-input--multiline ${className}`}
        data-cell={cell}
        onClick={onEdit}
        aria-label={multilineCellLabel(label)}
        title={value}
      >
        {formatCellPreview(value)}
      </button>
    );
  }

  return (
    <input
      className={`cell-input ${className}`}
      data-cell={cell}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
    />
  );
}
