import type { JSX } from 'react';
import { formatCellPreview, isMultiline } from '../lib/format';
import { Icon } from './Icon';
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
  /**
   * 1行入力のときも「複数行で編集」ボタンを出すか。
   *
   * 表では Shift+Enter で開けるが、カード表示（＝狭い画面・タッチ）には
   * キーボードが無いことがあるので、押せる入口を置く。
   */
  showEditButton?: boolean;
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
  showEditButton = false,
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

  const input = (
    <input
      className={`cell-input ${className}`}
      data-cell={cell}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
    />
  );

  if (!showEditButton) return input;

  return (
    <>
      {input}
      <button
        type="button"
        className="icon-btn icon-btn--bare icon-btn--compact"
        onClick={onEdit}
        title="複数行で編集"
        aria-label={`${label}を複数行で編集`}
      >
        <Icon name="expand" size={15} />
      </button>
    </>
  );
}
