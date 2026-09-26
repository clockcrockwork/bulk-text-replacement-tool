import { type JSX, useEffect, useRef } from 'react';

export interface ConfirmRequest {
  /** 見出し。「何をしようとしているか」を動詞で書く。 */
  title: string;
  /** 本文。実行すると何が起きるかを1〜2文で。 */
  message: string;
  /** 失われるものの内訳。件数や名前を並べる。 */
  details?: readonly string[];
  /** 実行ボタンの文言。結果が読める動詞にする（「削除する」など）。 */
  confirmLabel: string;
}

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 取り返しのつかない操作の前に出す確認。
 *
 * ネイティブの `<dialog>` を使うので、Escape での閉じ・フォーカストラップ・
 * 背面の不活性化はブラウザ任せにできる（`ImportDialog` と同じ作法）。
 * `window.confirm` を使わないのは、文言を整えられず、失われる内容の内訳も
 * 出せず、iOS Safari では表示が抑制され得るため。
 *
 * 既定のフォーカスは「キャンセル」に置く。Enter の連打で破壊操作が通る状態を作らない。
 */
export function ConfirmDialog({ request, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでの閉じる操作は <dialog> 標準の Escape（onCancel）が担う
    <dialog
      ref={dialogRef}
      className="dialog dialog--confirm"
      aria-label={request.title}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onCancel();
      }}
    >
      <div className="dialog__inner">
        <h2 className="dialog__title">{request.title}</h2>
        <p className="dialog__lead">{request.message}</p>
        {request.details && request.details.length > 0 ? (
          <ul className="dialog__details">
            {request.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            キャンセル
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
