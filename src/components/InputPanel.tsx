import type { ChangeEvent, JSX, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { formatIndex, formatInputSummary, formatTextMeta } from '../lib/format';
import { ACCEPT_ATTRIBUTE, ACCEPTED_EXTENSIONS_LABEL } from '../lib/inputFiles';
import type { InputText } from '../types';
import { Icon } from './Icon';

export interface InputPanelProps {
  inputs: readonly InputText[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFiles: () => void;
  onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onAddInput: () => void;
  onClearInputs: () => void;
  onRenameInput: (id: string, title: string) => void;
  onRemoveInput: (id: string) => void;
  /** プレビューから全画面エディタを開く。キャレット位置とスクロール比率を引き継ぐ。 */
  onOpenEditor: (id: string, caret: number, scrollRatio: number) => void;
}

export function InputPanel({
  inputs,
  fileInputRef,
  onPickFiles,
  onFilesSelected,
  onAddInput,
  onClearInputs,
  onRenameInput,
  onRemoveInput,
  onOpenEditor,
}: InputPanelProps): JSX.Element {
  const totalChars = inputs.reduce((sum, input) => sum + input.text.length, 0);

  const handlePreviewClick = (id: string) => (event: MouseEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    const ratio = target.scrollTop / Math.max(1, target.scrollHeight);
    onOpenEditor(id, target.selectionStart, ratio);
  };

  const handlePreviewKey = (id: string) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpenEditor(id, event.currentTarget.selectionStart, 0);
  };

  return (
    <section className="panel panel--loose" aria-label="入力">
      <div className="dropzone">
        <div className="dropzone__body">
          <div className="dropzone__title">テキストを追加</div>
          <div className="dropzone__hint">
            ここにファイルをドラッグ＆ドロップ · {ACCEPTED_EXTENSIONS_LABEL} · 複数可
          </div>
        </div>
        <div className="dropzone__actions">
          <button type="button" className="btn btn--primary" onClick={onPickFiles}>
            <Icon name="upload" />
            <span>ファイルを選択</span>
          </button>
          <button type="button" className="btn" onClick={onAddInput}>
            <Icon name="plus" />
            <span>テキスト欄を追加</span>
          </button>
          <button type="button" className="btn" disabled title="準備中">
            <Icon name="github" />
            <span>GitHubから取り込み</span>
            <span className="tag">準備中</span>
          </button>
        </div>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          onChange={onFilesSelected}
        />
      </div>

      <div className="section-head">
        <div className="section-head__title">入力テキスト</div>
        <div className="section-head__meta">{formatInputSummary(inputs.length, totalChars)}</div>
        {inputs.length > 0 ? (
          <button type="button" className="btn btn--quiet" onClick={onClearInputs}>
            すべて削除
          </button>
        ) : null}
      </div>

      {inputs.length === 0 ? (
        <div className="empty">
          入力がありません。ファイルをドロップするか「テキスト欄を追加」を押してください。
        </div>
      ) : null}

      <div className="card-grid">
        {inputs.map((input, index) => (
          <div key={input.id} className="input-card" data-input-id={input.id}>
            <div className="input-card__head">
              <span className="input-card__num">{formatIndex(index)}</span>
              <input
                className="cell-input input-card__title"
                value={input.title}
                onChange={(event) => onRenameInput(input.id, event.target.value)}
                placeholder="ファイル名（例: chapter1.md）"
                aria-label="ファイル名"
              />
              <button
                type="button"
                className="icon-btn icon-btn--bare icon-btn--danger input-card__delete"
                onClick={() => onRemoveInput(input.id)}
                title="削除"
                aria-label="削除"
              >
                <Icon name="close" />
              </button>
            </div>
            <textarea
              className="input-card__preview"
              readOnly
              value={input.text}
              onClick={handlePreviewClick(input.id)}
              onKeyDown={handlePreviewKey(input.id)}
              placeholder="タップして本文を入力・貼り付け"
              aria-label="本文（クリックで編集）"
              spellCheck={false}
            />
            <div className="input-card__foot">
              <span className="input-card__meta">{formatTextMeta(input.text)}</span>
              <span className="input-card__action-hint">クリックで編集</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
