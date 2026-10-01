import { Component, type ErrorInfo, type ReactNode } from 'react';
import { workspaceRecovery } from '../hooks/usePersistedWorkspace';
import { buildRecoveryBackup } from '../lib/backup';
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
    downloadRecoveryBackup(raw, 'backup');
  };

  /**
   * 保存データに入っていない最新の作業を退避する（issue #32）。保存に失敗していた間や、
   * 別のタブに保存データを上書きされたあとに落ちると、保存データだけでは救えない。
   */
  private readonly handleDownloadLatest = (): void => {
    const latest = workspaceRecovery.unsaved();
    if (!latest) return;
    downloadRecoveryBackup(JSON.stringify(latest), 'latest');
  };

  private readonly handleReset = (): void => {
    clearWorkspace();
    location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const hasSavedData = readRawWorkspace() !== null;
    const hasUnsaved = workspaceRecovery.unsaved() !== null;

    return (
      <div className="recovery" role="alert">
        <h1 className="recovery__title">画面の表示に失敗しました</h1>
        <p className="recovery__lead">
          保存されているデータが原因の場合、再読み込みしても同じ状態になります。
          保存データを消すと直ることがありますが、入力した原稿もルール表も一緒に失われます。
          削除する前に「保存データをダウンロード」で手元に保存しておくことをおすすめします。
          ダウンロードしたファイルは、あとで「作業データ」の「ファイルを選んで読み込む」から戻せます。
        </p>
        {hasUnsaved ? (
          <p className="recovery__lead">
            ブラウザに保存できていない作業があります（保存に失敗していた・保存の直前だった・
            別のタブで作業データが更新された、のいずれか）。再読み込みすると失われるので、
            「最新の作業内容をダウンロード」で退避してください。表示に失敗した原因がこの内容に
            ある場合もあるため、保存データの方も一緒に退避しておくと安全です。
          </p>
        ) : null}
        <pre className="recovery__detail">{error.message}</pre>
        <div className="recovery__actions">
          {hasUnsaved ? (
            <button type="button" className="btn" onClick={this.handleDownloadLatest}>
              最新の作業内容をダウンロード
            </button>
          ) : null}
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
            保存データを削除して初期状態に戻す
          </button>
        </div>
      </div>
    );
  }
}

/**
 * 通常の「作業データの読み込み」でそのまま読み戻せる形にして落とす。中身は正規化しない
 * （`buildRecoveryBackup`）。最新の作業と保存データを両方退避したときに見分けられるよう、
 * 名前に種類を入れる。
 */
function downloadRecoveryBackup(raw: string, kind: 'backup' | 'latest'): void {
  const at = new Date();
  downloadBlob(
    new Blob([buildRecoveryBackup(raw, at)], { type: 'application/json' }),
    `bulk-replace-${kind}-${timestampForFileName(at)}.json`,
  );
}
