import type { JSX } from 'react';
import { formatTime } from '../lib/format';
import type { FileView } from '../state/workspace';
import type { ConversionResult, ResultFile, ResultGroup } from '../types';
import { Icon } from './Icon';

export interface OutputPanelProps {
  result: ConversionResult | null;
  /** 表示中のグループ。null なら先頭を出す。 */
  outGroupId: string | null;
  /** `${groupId}:${fileIndex}` → 表示モード。未設定はハイライト。 */
  fileViews: Record<string, FileView>;
  /** 変換後に入力・ルールが変わっているか。 */
  stale: boolean;
  onRun: () => void;
  onSelectGroup: (id: string) => void;
  onSetFileView: (key: string, view: FileView) => void;
  onDownloadZip: () => void;
  onCopyFile: (file: ResultFile) => void;
  onDownloadFile: (file: ResultFile) => void;
}

function EmptyState({ onRun }: { onRun: () => void }): JSX.Element {
  return (
    <div className="empty empty--cta">
      <div className="empty__title">まだ変換していません</div>
      <div>入力とルールを確認したら「変換」を押してください。</div>
      <button type="button" className="btn btn--primary" onClick={onRun}>
        <Icon name="play" size={14} />
        <span>変換する</span>
      </button>
    </div>
  );
}

function summarize(result: ConversionResult, group: ResultGroup | undefined): string {
  return `${formatTime(result.at)} 変換 · ${result.groups.length} グループ × ${group?.files.length ?? 0} ファイル`;
}

export function OutputPanel({
  result,
  outGroupId,
  fileViews,
  stale,
  onRun,
  onSelectGroup,
  onSetFileView,
  onDownloadZip,
  onCopyFile,
  onDownloadFile,
}: OutputPanelProps): JSX.Element {
  if (!result) {
    return (
      <section className="panel" aria-label="出力">
        <EmptyState onRun={onRun} />
      </section>
    );
  }

  const current = result.groups.find((group) => group.id === outGroupId) ?? result.groups[0];

  return (
    <section className="panel" aria-label="出力">
      <div className="result-bar">
        <div className="result-bar__summary">{summarize(result, current)}</div>
        {stale ? <span className="badge">未反映の変更があります</span> : null}
        <span className="spacer" />
        {stale ? (
          <button type="button" className="btn" onClick={onRun}>
            再変換
          </button>
        ) : null}
        <button type="button" className="btn btn--primary" onClick={onDownloadZip}>
          <Icon name="download" />
          <span>ZIPで全て保存</span>
        </button>
      </div>

      <div className="out-tabs">
        {result.groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`out-tab${group.id === current?.id ? ' is-active' : ''}`}
            aria-current={group.id === current?.id ? 'true' : undefined}
            onClick={() => onSelectGroup(group.id)}
          >
            <span>{group.name}</span>
            <span className="out-tab__count">{group.hits}件</span>
          </button>
        ))}
      </div>

      <div className="file-list">
        {current?.files.map((file, index) => {
          const key = `${current.id}:${index}`;
          const highlighted = (fileViews[key] ?? 'highlight') === 'highlight';
          return (
            <div key={key} className="file-card">
              <div className="file-card__head">
                <span className="file-card__path">
                  {current.dir}/{file.title}
                </span>
                <span className="badge">{file.hits}箇所を置換</span>
                <span className="spacer" />
                <fieldset className="toggle-group">
                  <legend className="visually-hidden">本文の表示</legend>
                  <button
                    type="button"
                    className={`toggle${highlighted ? ' is-active' : ''}`}
                    aria-pressed={highlighted}
                    onClick={() => onSetFileView(key, 'highlight')}
                  >
                    ハイライト
                  </button>
                  <button
                    type="button"
                    className={`toggle${highlighted ? '' : ' is-active'}`}
                    aria-pressed={!highlighted}
                    onClick={() => onSetFileView(key, 'plain')}
                  >
                    テキスト
                  </button>
                </fieldset>
                <button type="button" className="btn btn--small" onClick={() => onCopyFile(file)}>
                  <Icon name="copy" size={15} />
                  <span>コピー</span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onDownloadFile(file)}
                  title="このファイルを保存"
                  aria-label="このファイルを保存"
                >
                  <Icon name="download" size={15} />
                </button>
              </div>
              {highlighted ? (
                <div className="file-card__body">
                  {file.segments.map((segment, segmentIndex) =>
                    segment.hit ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 断片は位置でしか識別できず、並び替えも起きない
                      <mark key={segmentIndex}>{segment.text}</mark>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                      <span key={segmentIndex}>{segment.text}</span>
                    ),
                  )}
                </div>
              ) : (
                <textarea
                  className="file-card__plain"
                  readOnly
                  value={file.text}
                  spellCheck={false}
                  aria-label="変換後の本文"
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
