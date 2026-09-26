import type { Group, Rule } from '../types';

/** ルール1行の表示に必要な情報をまとめたビューモデル。 */
export interface RuleRow {
  rule: Rule;
  index: number;
  /** 正規表現のコンパイルエラー。無ければ null。 */
  error: string | null;
  /** グループIDごとのヒット数。未変換なら undefined。 */
  hits: Record<string, number | undefined>;
}

export interface RuleHandlers {
  onChangeSrc: (id: string, value: string) => void;
  onChangeValue: (ruleId: string, groupId: string, value: string) => void;
  onToggleRegex: (rule: Rule) => void;
  onToggleCase: (rule: Rule) => void;
  onToggleOrder: (rule: Rule) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (id: string) => void;
}

export interface GroupHandlers {
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export interface RuleGridProps {
  rows: readonly RuleRow[];
  groups: readonly Group[];
  ruleHandlers: RuleHandlers;
  groupHandlers: GroupHandlers;
}

/** キーボード移動用のセル座標。列0が置換元、列 n が n 番目のグループ。 */
export function cellId(row: number, col: number): string {
  return `${row}:${col}`;
}
