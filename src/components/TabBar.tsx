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
          {/* 赤い点だけだと色の見えない環境・読み上げに何も伝わらないので、文字も添える。 */}
          {tab.badge ? (
            <>
              <span className="tab__badge" aria-hidden="true" />
              <span className="visually-hidden">未反映の変更があります</span>
            </>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
