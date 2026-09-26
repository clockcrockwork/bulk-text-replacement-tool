import type { JSX } from 'react';
import type { Theme } from '../types';
import { Icon } from './Icon';

export interface AppHeaderProps {
  theme: Theme;
  onToggleTheme: () => void;
  onRun: () => void;
}

export function AppHeader({ theme, onToggleTheme, onRun }: AppHeaderProps): JSX.Element {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand__mark" />
        <span className="brand__name">一括置換</span>
      </div>
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleTheme}
        title="テーマ切替"
        aria-label="テーマ切替"
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
      </button>
      <button type="button" className="btn btn--primary" onClick={onRun}>
        <Icon name="play" size={14} />
        <span>変換</span>
      </button>
    </header>
  );
}
