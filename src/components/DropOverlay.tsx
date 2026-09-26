import type { JSX } from 'react';
import { ACCEPTED_EXTENSIONS_LABEL } from '../lib/inputFiles';

/** ファイルをドラッグ中に画面全体へ出す案内。クリックは透過させる。 */
export function DropOverlay(): JSX.Element {
  return (
    <div className="drop-overlay">
      <div className="drop-overlay__panel">
        <div className="drop-overlay__title">ドロップして追加</div>
        <div className="drop-overlay__hint">{ACCEPTED_EXTENSIONS_LABEL} · 複数ファイル可</div>
      </div>
    </div>
  );
}
