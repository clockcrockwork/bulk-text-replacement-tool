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

/**
 * ルール表のセルのアクセシブル名。
 *
 * 全セルが「置換元」「置換先」だけだと、スクリーンリーダーの要素一覧では
 * 同じ名前が並ぶだけでどの行・どの列か分からない。行番号と、置換先なら
 * グループ名まで含める。
 */
export function srcCellLabel(index: number): string {
  return `${index + 1}行目の置換元`;
}

export function valueCellLabel(index: number, groupName: string): string {
  return `${index + 1}行目の置換先（${groupName || '無名のグループ'}）`;
}
