import { Component, type ErrorInfo, type ReactNode } from 'react';
import { downloadBlob } from '../lib/browser';
import { timestampForFileName } from '../lib/format';
import { clearWorkspace, readRawWorkspace } from '../lib/storage';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 描画中の例外を受け止めて復旧手段を出す。
 *
 * このアプリの状態は localStorage に永続化されるので、保存データが原因で落ちると
 * リロードしても同じ場所で落ち続ける。白画面のまま DevTools を開くしか手が無い、
 * という状態を作らないための最後の受け皿。消す前に退避できるようにしてある。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 本番でも原因を追えるように、握り潰さずコンソールには出す。
    console.error('描画中に例外が発生しました', error, info.componentStack);
  }

  private readonly handleDownload = (): void => {
    const raw = readRawWorkspace();
    if (!raw) return;
    downloadBlob(
      new Blob([raw], { type: 'application/json' }),
      `bulk-replace-backup-${timestampForFileName(new Date())}.json`,
    );
  };

  private readonly handleReset = (): void => {
    clearWorkspace();
    location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const hasSavedData = readRawWorkspace() !== null;

    return (
      <div className="recovery" role="alert">
        <h1 className="recovery__title">画面の表示に失敗しました</h1>
        <p className="recovery__lead">
          保存されているデータが原因の場合、再読み込みしても同じ状態になります。
          保存データを消すと直ることがありますが、入力した原稿もルール表も一緒に失われます。
          先に「保存データをダウンロード」で手元に落としてから消してください。
        </p>
        <pre className="recovery__detail">{error.message}</pre>
        <div className="recovery__actions">
          <button
            type="button"
            className="btn"
            onClick={this.handleDownload}
            disabled={!hasSavedData}
          >
            保存データをダウンロード
          </button>
          <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
            再読み込み
          </button>
          {/* 取り返しのつかない操作なので、既定の見た目のまま最後に置く。 */}
          <button type="button" className="btn" onClick={this.handleReset} disabled={!hasSavedData}>
            保存データを消して再読み込み
          </button>
        </div>
      </div>
    );
  }
}
