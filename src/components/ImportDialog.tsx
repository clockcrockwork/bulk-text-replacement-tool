import { type ChangeEvent, type JSX, type RefObject, useEffect, useRef } from 'react';
import { useBackdropClose } from '../hooks/useBackdropClose';
import { findRaggedRows, OPTION_HEADERS, type ParsedTable, TABLE_KIND_LABEL } from '../lib/table';
import type { ImportMode } from '../types';
import { Icon } from './Icon';
import { ToggleGroup, type ToggleOption } from './ToggleGroup';

const PLACEHOLDER = [
  '| 元テキスト | A用置換 | B用置換 |',
  '| --- | --- | --- |',
  '| アリス | あーちゃん | びーちゃん |',
].join('\n');

const IMPORT_MODE_OPTIONS: readonly ToggleOption<ImportMode>[] = [
  { value: 'replace', label: '置き換える' },
  { value: 'append', label: '末尾に追加' },
];

/** 解析結果を1行の説明文にする。 */
function describe(parsed: ParsedTable): string {
  if (!parsed.kind || parsed.rows.length === 0) return '未入力';
  const columns = Math.max(0, (parsed.rows[0]?.length ?? 0) - 1);
  return `${TABLE_KIND_LABEL[parsed.kind]} · 見出し＋${parsed.rows.length - 1}行 · ${columns}列`;
}

/** ダイアログの中に出す知らせ。`error` は読み込めなかったこと、`info` は確かめてほしいこと。 */
export interface ImportNotice {
  tone: 'error' | 'info';
  message: string;
}

export interface ImportDialogProps {
  text: string;
  mode: ImportMode;
  parsed: ParsedTable;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onChangeText: (text: string) => void;
  onChangeMode: (mode: ImportMode) => void;
  onPickFile: () => void;
  onFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  notice: ImportNotice | null;
  onClose: () => void;
  onApply: () => void;
}

/**
 * Markdown 表 / CSV / TSV からルールを読み込むモーダル。
 * ネイティブの `<dialog>` を使うので、Escape での閉じ・フォーカストラップ・
 * 背面の不活性化はブラウザ任せにできる。
 */
export function ImportDialog({
  text,
  mode,
  parsed,
  fileInputRef,
  onChangeText,
  onChangeMode,
  onPickFile,
  onFileSelected,
  notice,
  onClose,
  onApply,
}: ImportDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropClose(dialogRef, () => onClose());
  const ragged = findRaggedRows(parsed.rows);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    // 背景のクリックで閉じる（useBackdropClose）。キーボードでは <dialog> 標準の Escape（onCancel）で閉じる
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-label="表から読み込み"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // 背景（::backdrop）のクリックでも閉じる。中身のクリックは子要素が target になる。
      {...backdrop}
    >
      <div className="dialog__inner">
        <h2 className="dialog__title">表から読み込み</h2>
        <p className="dialog__lead">
          Markdown
          表・CSV・TSVを貼り付けるか、ファイルを選択。1行目は見出しで、1列目が置換元（見出しは何でも構いません）、
          残りの列がグループ名になります。見出しを「{OPTION_HEADERS.regex}」「{OPTION_HEADERS.cs}」
          「{OPTION_HEADERS.order}」にした列はグループではなく、その行の設定として読み込みます。
          置換先が空欄のセルは、そのグループでは置換しません（削除ではありません）。
        </p>
        <textarea
          className="dialog__textarea"
          value={text}
          onChange={(event) => onChangeText(event.target.value)}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          aria-label="表のテキスト"
        />
        <div className="dialog__row">
          <button type="button" className="btn btn--small" onClick={onPickFile}>
            <Icon name="upload" size={15} />
            <span>ファイルを選択</span>
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".csv,.tsv,.md,.txt"
            onChange={onFileSelected}
          />
          <span className="dialog__detect">{describe(parsed)}</span>
        </div>
        {notice ? (
          <p
            className={notice.tone === 'error' ? 'dialog__error' : 'dialog__lead'}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            {notice.message}
          </p>
        ) : null}

        {ragged.length > 0 ? (
          <p className="dialog__error" role="status">
            見出しと列数が違う行があります（{ragged.length}行目
            {ragged.length > 1 ? ` ほか${ragged.length - 1}件` : ''}
            ）。区切りが壊れていると、一部だけ違うルールとして読み込まれます。
          </p>
        ) : null}
        <div className="dialog__row">
          <span className="hint">現在のルール表</span>
          <ToggleGroup
            legend="現在のルール表の扱い"
            value={mode}
            options={IMPORT_MODE_OPTIONS}
            onChange={onChangeMode}
          />
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn--primary" onClick={onApply}>
            読み込む
          </button>
        </div>
      </div>
    </dialog>
  );
}
