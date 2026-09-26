import { type JSX, type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { resolveGridNav } from '../lib/gridNav';
import { compileRule } from '../lib/regex';
import type { ConversionResult, Group, Rule } from '../types';
import { Icon } from './Icon';
import { RuleCards } from './RuleCards';
import { RuleTable } from './RuleTable';
import type { GroupHandlers, RuleHandlers, RuleRow } from './ruleTypes';
import { ToggleGroup, type ToggleOption } from './ToggleGroup';

/** IME 変換確定中の Enter を表す keyCode。移動に使ってしまうと変換が中断される。 */
const IME_KEY_CODE = 229;

const VIEW_OPTIONS: readonly ToggleOption<'table' | 'card'>[] = [
  { value: 'table', label: '表' },
  { value: 'card', label: 'カード' },
];

const KEY_HINT_CARDS = '↑↓ / Tab で前後の欄へ · Enter で次の欄（最後の欄なら行を追加）';
const KEY_HINT_TABLE =
  '↑↓ / Enter で上下の行へ · ← → / Tab で左右の欄へ · 最終行で Enter を押すと行を追加';

function focusCell(row: number, col: number): boolean {
  const element = document.querySelector<HTMLInputElement>(`[data-cell="${row}:${col}"]`);
  if (!element) return false;
  element.focus();
  const end = element.value.length;
  element.setSelectionRange(end, end);
  return true;
}

export interface RulesPanelProps {
  groups: readonly Group[];
  rules: readonly Rule[];
  result: ConversionResult | null;
  /** カード表示にするか（画面幅または明示的な切り替えで決まる）。 */
  cards: boolean;
  onSetView: (view: 'table' | 'card') => void;
  onAddRule: () => void;
  ruleHandlers: RuleHandlers;
  groupHandlers: GroupHandlers;
  onOpenImport: () => void;
  onExportCsv: () => void;
  onExportTsv: () => void;
}

export function RulesPanel({
  groups,
  rules,
  result,
  cards,
  onSetView,
  onAddRule,
  ruleHandlers,
  groupHandlers,
  onOpenImport,
  onExportCsv,
  onExportTsv,
}: RulesPanelProps): JSX.Element {
  // 正規表現ルールの数だけ new RegExp が走るので、打鍵のたびには作り直さない。
  const rows: RuleRow[] = useMemo(
    () =>
      rules.map((rule, index) => {
        const compiled = rule.regex && rule.src ? compileRule(rule) : null;
        return {
          rule,
          index,
          error: compiled?.kind === 'error' ? compiled.message : null,
          hits: Object.fromEntries(
            groups.map((group) => [
              group.id,
              rule.src ? result?.hitsByGroupRule[group.id]?.[rule.id] : undefined,
            ]),
          ),
        };
      }),
    [rules, groups, result],
  );

  // 「最終行で Enter」で行を足したあと、増えた行にフォーカスを移す。
  const pendingFocus = useRef<{ row: number; col: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 行数が増えた描画のあとにだけ実行する
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    focusCell(target.row, target.col);
  }, [rules.length]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const cell = target.dataset.cell;
    if (!cell) return;
    if (event.nativeEvent.isComposing || event.keyCode === IME_KEY_CODE) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const [row = 0, col = 0] = cell.split(':').map(Number);
    const action = resolveGridNav({
      key: event.key,
      shiftKey: event.shiftKey,
      row,
      col,
      rows: rules.length,
      cols: groups.length + 1,
      cards,
      atStart: target.selectionStart === 0 && target.selectionEnd === 0,
      atEnd: target.selectionStart === target.value.length,
    });

    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'move') {
      focusCell(action.row, action.col);
      return;
    }
    pendingFocus.current = { row: rules.length, col: action.col };
    onAddRule();
  };

  const grid = { rows, groups, ruleHandlers, groupHandlers };

  return (
    <section className="panel" aria-label="ルール" onKeyDown={handleKeyDown}>
      <div className="toolbar">
        <button type="button" className="btn" onClick={onAddRule}>
          <Icon name="plus" />
          <span>行を追加</span>
        </button>
        <button type="button" className="btn" onClick={groupHandlers.onAdd}>
          <Icon name="plus" />
          <span>グループ（列）を追加</span>
        </button>
        <ToggleGroup
          legend="ルールの表示形式"
          value={cards ? 'card' : 'table'}
          options={VIEW_OPTIONS}
          onChange={onSetView}
          tall
        />
        <span className="spacer" />
        <button type="button" className="btn" onClick={onOpenImport}>
          <Icon name="table" />
          <span>表から読み込み</span>
        </button>
        <button type="button" className="btn" onClick={onExportCsv}>
          <Icon name="download" />
          <span>CSV</span>
        </button>
        <button type="button" className="btn" onClick={onExportTsv}>
          <Icon name="download" />
          <span>TSV</span>
        </button>
      </div>

      <div className="legend">
        <div className="legend__item">
          <b className="legend__key legend__key--mono">.*</b>
          <span>正規表現として扱う。置換先で $1 などが使えます</span>
        </div>
        <div className="legend__item">
          <b className="legend__key legend__key--mono">Aa</b>
          <span>大文字・小文字を区別する</span>
        </div>
        <div className="legend__item">
          <b className="legend__key">同時</b>
          <span>連続する「同時」行はまとめて1回で置換（長い一致を優先・連鎖しない）</span>
        </div>
        <div className="legend__item">
          <b className="legend__key">順次</b>
          <span>それまでの置換結果に対して単独で適用。空欄のセルは置換しません</span>
        </div>
      </div>

      <div className="hint">{cards ? KEY_HINT_CARDS : KEY_HINT_TABLE}</div>

      {cards ? <RuleCards {...grid} /> : <RuleTable {...grid} />}

      <button type="button" className="btn btn--dashed" onClick={onAddRule}>
        <Icon name="plus" />
        <span>行を追加</span>
      </button>
    </section>
  );
}
