import { type ChangeEvent, type JSX, type RefObject, useEffect, useRef } from 'react';
import type { BackupSummary } from '../lib/backup';
import { Icon } from './Icon';

/** 読み込んだファイルの検証結果。反映はユーザーが確認してから。 */
export type BackupCandidate =
  | { kind: 'ok'; fileName: string; summary: BackupSummary }
  | { kind: 'error'; fileName: string; message: string };

interface BackupDialogProps {
  candidate: BackupCandidate | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onExport: () => void;
  onPickFile: () => void;
  onFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onApply: () => void;
  onClose: () => void;
}

function formatSavedAt(iso: string | null): string {
  if (!iso) return '保存日時なし';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '保存日時なし' : `${date.toLocaleString()} の作業データ`;
}

/**
 * 作業データ（原稿・グループ・ルール）の書き出しと読み込み。
 *
 * 読み込みは「ファイルを選ぶ → 中身を確かめる → 置き換えを確定する」の3段階にする。
 * 選んだ瞬間に反映すると、壊れたファイルや別の版を選んだだけで今のデータが消え、
 * 復旧手段そのものが新しいデータ消失の経路になる。
 */
export function BackupDialog({
  candidate,
  fileInputRef,
  onExport,
  onPickFile,
  onFileSelected,
  onApply,
  onClose,
}: BackupDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでの閉じる操作は <dialog> 標準の Escape（onCancel）が担う
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-label="作業データ"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="dialog__inner">
        <h2 className="dialog__title">作業データ</h2>
        <p className="dialog__lead">
          原稿・グループ・ルールをまとめた JSON です。このアプリはブラウザの中にしか保存しないので、
          サイトデータの削除や、Safari で数日開かなかったときに消えることがあります。
          大事な原稿は書き出して手元に置いてください。
        </p>

        <div className="dialog__row">
          <button type="button" className="btn btn--primary" onClick={onExport}>
            <Icon name="download" size={15} />
            <span>書き出す</span>
          </button>
          <button type="button" className="btn" onClick={onPickFile}>
            <Icon name="upload" size={15} />
            <span>ファイルを選んで読み込む</span>
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            onChange={onFileSelected}
          />
        </div>

        {candidate?.kind === 'error' ? (
          <p className="dialog__error" role="alert">
            {candidate.fileName} は読み込めません。{candidate.message}
          </p>
        ) : null}

        {candidate?.kind === 'ok' ? (
          <section className="dialog__confirm" aria-label="読み込む内容の確認">
            <p className="dialog__lead">
              {candidate.fileName}（{formatSavedAt(candidate.summary.savedAt)}）
            </p>
            <ul className="dialog__details">
              <li>入力 {candidate.summary.inputs}件</li>
              <li>グループ {candidate.summary.groups}件</li>
              <li>ルール {candidate.summary.rules}行</li>
            </ul>
            <p className="dialog__lead">
              読み込むと、いま画面にある入力・グループ・ルールはすべて置き換わります。
            </p>
            <button type="button" className="btn btn--primary" onClick={onApply}>
              現在のデータを置き換える
            </button>
          </section>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </dialog>
  );
}
