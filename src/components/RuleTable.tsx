import type { JSX } from 'react';
import { SOURCE_HEADER } from '../lib/table';
import { Icon } from './Icon';
import { RuleFlags, RuleRowActions } from './RuleFlags';
import { cellId, type RuleGridProps } from './ruleTypes';

/** 広い画面向けのルール表。置換元の列は横スクロールしても左に固定する。 */
export function RuleTable({
  rows,
  groups,
  ruleHandlers,
  groupHandlers,
}: RuleGridProps): JSX.Element {
  return (
    <div className="rule-table-wrap">
      <table className="rule-table">
        <thead>
          <tr>
            <th className="rule-table__src-head">
              <div className="rule-table__label">{SOURCE_HEADER}</div>
            </th>
            {groups.map((group) => (
              <th key={group.id} className="rule-table__group-head">
                <div className="rule-table__group-head-inner">
                  <input
                    className="cell-input rule-table__group-name"
                    value={group.name}
                    onChange={(event) => groupHandlers.onRename(group.id, event.target.value)}
                    aria-label="グループ名"
                    placeholder="グループ名"
                  />
                  <button
                    type="button"
                    className="icon-btn icon-btn--bare icon-btn--danger rule-table__group-delete"
                    onClick={() => groupHandlers.onRemove(group.id)}
                    disabled={groups.length <= 1}
                    title="この列を削除"
                    aria-label="この列を削除"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </th>
            ))}
            <th className="rule-table__add-head">
              <button
                type="button"
                className="rule-table__add-group"
                onClick={groupHandlers.onAdd}
                title="グループ（列）を追加"
                aria-label="グループ（列）を追加"
              >
                <Icon name="plus" strokeWidth={2.4} />
              </button>
            </th>
            <th className="rule-table__options-head">
              <div className="rule-table__label">オプション</div>
            </th>
            <th className="rule-table__actions-head">
              <div className="rule-table__label">操作</div>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ rule, index, error, hits }) => (
            <tr key={rule.id}>
              <td className="rule-table__src-cell">
                <input
                  className="cell-input rule-table__input"
                  data-cell={cellId(index, 0)}
                  value={rule.src}
                  onChange={(event) => ruleHandlers.onChangeSrc(rule.id, event.target.value)}
                  placeholder="置換元"
                  aria-label="置換元"
                />
                {error ? <div className="rule-table__error">{error}</div> : null}
              </td>
              {groups.map((group, groupIndex) => {
                const hit = hits[group.id];
                return (
                  <td key={group.id}>
                    <div className="rule-table__value-cell">
                      <input
                        className="cell-input rule-table__input"
                        data-cell={cellId(index, groupIndex + 1)}
                        value={rule.values[group.id] ?? ''}
                        onChange={(event) =>
                          ruleHandlers.onChangeValue(rule.id, group.id, event.target.value)
                        }
                        placeholder="—"
                        aria-label="置換先"
                      />
                      {hit !== undefined ? (
                        <span
                          className={`rule-table__hits hits${hit > 0 ? ' is-positive' : ''}`}
                          title="ヒット件数（全入力の合計）"
                        >
                          {hit}件
                        </span>
                      ) : null}
                    </div>
                  </td>
                );
              })}
              <td />
              <td>
                <div className="rule-table__buttons">
                  <RuleFlags rule={rule} handlers={ruleHandlers} compact />
                </div>
              </td>
              <td className="rule-table__actions-cell">
                <div className="rule-table__buttons rule-table__buttons--tight">
                  <RuleRowActions
                    rule={rule}
                    index={index}
                    total={rows.length}
                    handlers={ruleHandlers}
                    compact
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
