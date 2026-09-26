import type { JSX } from 'react';
import type { Tab } from '../types';

export interface TabDescriptor {
  key: Tab;
  label: string;
  /** タブ名の右に出す件数。未変換のときは `—`。 */
  count: string;
  /** 変換後に入力が変わったことを示す赤点。 */
  badge?: boolean;
}

export interface TabBarProps {
  tabs: readonly TabDescriptor[];
  current: Tab;
  onSelect: (tab: Tab) => void;
}

export function TabBar({ tabs, current, onSelect }: TabBarProps): JSX.Element {
  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`tab${tab.key === current ? ' is-active' : ''}`}
          aria-current={tab.key === current ? 'page' : undefined}
          onClick={() => onSelect(tab.key)}
        >
          <span className="tab__label">{tab.label}</span>
          <span className="tab__count">{tab.count}</span>
          {tab.badge ? <span className="tab__badge" title="未反映の変更があります" /> : null}
        </button>
      ))}
    </nav>
  );
}
