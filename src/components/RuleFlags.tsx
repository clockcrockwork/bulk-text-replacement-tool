import type { JSX } from 'react';
import type { Rule } from '../types';
import { Icon } from './Icon';
import type { RuleHandlers } from './ruleTypes';

export interface RuleFlagsProps {
  rule: Rule;
  handlers: RuleHandlers;
  /** 表表示では小さいボタンを使う。 */
  compact?: boolean;
}

/** 正規表現 / 大小区別 / 適用順の3つのトグル。 */
export function RuleFlags({ rule, handlers, compact = false }: RuleFlagsProps): JSX.Element {
  const size = compact ? ' flag--compact' : '';
  return (
    <>
      <button
        type="button"
        className={`flag${size}${rule.regex ? ' is-active' : ''}`}
        onClick={() => handlers.onToggleRegex(rule)}
        title="正規表現"
        aria-label="正規表現"
        aria-pressed={rule.regex}
      >
        .*
      </button>
      <button
        type="button"
        className={`flag${size}${rule.cs ? ' is-active' : ''}`}
        onClick={() => handlers.onToggleCase(rule)}
        title="大文字・小文字を区別"
        aria-label="大文字・小文字を区別"
        aria-pressed={rule.cs}
      >
        Aa
      </button>
      <button
        type="button"
        className={`flag flag--wide${size}${rule.order === 'seq' ? ' is-active' : ''}`}
        onClick={() => handlers.onToggleOrder(rule)}
        title="適用順：同時／順次"
        aria-label="適用順"
        aria-pressed={rule.order === 'seq'}
      >
        {rule.order === 'seq' ? '順次' : '同時'}
      </button>
    </>
  );
}

export interface RuleRowActionsProps {
  rule: Rule;
  index: number;
  total: number;
  handlers: RuleHandlers;
  compact?: boolean;
}

/** 行の並べ替えと削除。 */
export function RuleRowActions({
  rule,
  index,
  total,
  handlers,
  compact = false,
}: RuleRowActionsProps): JSX.Element {
  const size = compact ? ' icon-btn--compact' : '';
  const iconSize = compact ? 15 : 16;
  return (
    <>
      <button
        type="button"
        className={`icon-btn icon-btn--bare${size}`}
        onClick={() => handlers.onMove(index, -1)}
        disabled={index === 0}
        title="上へ"
        aria-label="上へ"
      >
        <Icon name="arrowUp" size={iconSize} />
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn--bare${size}`}
        onClick={() => handlers.onMove(index, 1)}
        disabled={index === total - 1}
        title="下へ"
        aria-label="下へ"
      >
        <Icon name="arrowDown" size={iconSize} />
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn--bare icon-btn--danger${size}`}
        onClick={() => handlers.onRemove(rule.id)}
        title="行を削除"
        aria-label="行を削除"
      >
        <Icon name="trash" size={iconSize} />
      </button>
    </>
  );
}
