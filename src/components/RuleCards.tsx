import type { JSX } from 'react';
import { formatIndex } from '../lib/format';
import { Icon } from './Icon';
import { RuleCell } from './RuleCell';
import { RuleFlags, RuleRowActions } from './RuleFlags';
import { cellId, type RuleGridProps, srcCellLabel, valueCellLabel } from './ruleTypes';

/** 狭い画面向けのルール表示。1ルール＝1カードで、グループごとの置換先を縦に並べる。 */
export function RuleCards({
  rows,
  groups,
  ruleHandlers,
  groupHandlers,
}: RuleGridProps): JSX.Element {
  return (
    <>
      <div className="group-list">
        <div className="group-list__label">グループ（出力先）</div>
        <div className="group-list__grid">
          {groups.map((group) => (
            <div key={group.id} className="group-chip">
              <input
                className="cell-input group-chip__name"
                value={group.name}
                onChange={(event) => groupHandlers.onRename(group.id, event.target.value)}
                aria-label="グループ名"
                placeholder="グループ名"
              />
              <button
                type="button"
                className="icon-btn icon-btn--bare icon-btn--danger group-chip__delete"
                onClick={() => groupHandlers.onRemove(group.id)}
                disabled={groups.length <= 1}
                title="このグループを削除"
                aria-label="このグループを削除"
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button type="button" className="group-list__add" onClick={groupHandlers.onAdd}>
            <Icon name="plus" strokeWidth={2.4} />
            <span>グループを追加</span>
          </button>
        </div>
      </div>

      <div className="rule-cards">
        {rows.map(({ rule, index, error, hits }) => (
          <div key={rule.id} className="rule-card">
            <div className="rule-card__head">
              <span className="rule-card__num">{formatIndex(index)}</span>
              <RuleCell
                className="rule-card__src"
                cell={cellId(index, 0)}
                value={rule.src}
                label={srcCellLabel(index)}
                placeholder="置換元"
                onChange={(value) => ruleHandlers.onChangeSrc(rule.id, value)}
                onEdit={() => ruleHandlers.onEditCell(rule.id, null)}
                showEditButton
              />
            </div>
            {error ? <div className="rule-card__error">{error}</div> : null}
            {groups.map((group, groupIndex) => {
              const hit = hits[group.id];
              return (
                // 複数行のセルは <button> になるので <label> では包めない。
                // 入力側の aria-label にグループ名まで入れてあるので、
                // ここは見出しの見た目だけを持つ器にする。
                <div key={group.id} className="rule-card__value">
                  <span className="rule-card__group-name">{group.name || '（無名）'}</span>
                  <RuleCell
                    className="rule-card__value-input"
                    cell={cellId(index, groupIndex + 1)}
                    value={rule.values[group.id] ?? ''}
                    label={valueCellLabel(index, group.name)}
                    placeholder="（置換しない）"
                    onChange={(value) => ruleHandlers.onChangeValue(rule.id, group.id, value)}
                    onEdit={() => ruleHandlers.onEditCell(rule.id, group.id)}
                    showEditButton
                  />
                  <span
                    className={`rule-card__hits hits${hit !== undefined && hit > 0 ? ' is-positive' : ''}`}
                  >
                    {hit !== undefined ? `${hit}件` : ''}
                  </span>
                </div>
              );
            })}
            <div className="rule-card__actions">
              <RuleFlags rule={rule} handlers={ruleHandlers} />
              <span className="spacer" />
              <RuleRowActions
                rule={rule}
                index={index}
                total={rows.length}
                handlers={ruleHandlers}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
