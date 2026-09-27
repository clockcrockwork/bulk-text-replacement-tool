import { type JSX, useEffect, useRef } from 'react';

interface CellEditorProps {
  /** 何を編集しているかの見出し（例: 「3行目の置換先（A用）」）。 */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

/**
 * ルール表の1セルを複数行で編集する。
 *
 * ルール表は大量のルールを横断して見る一覧なので、セル自体は1行入力のままにする
 * （行の高さが可変になると一覧性が落ちる）。改行を含む値はここで扱う。
 *
 * 1行の `<input>` に改行入りの値をそのまま載せると、編集した瞬間に改行が消える。
 * そうならないよう、複数行のセルは表では要約表示にして、実体の編集はここだけで行う。
 */
export function CellEditor({ label, value, onChange, onClose }: CellEditorProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    textareaRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでの閉じる操作は <dialog> 標準の Escape（onCancel）が担う
    <dialog
      ref={dialogRef}
      className="dialog dialog--cell"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="dialog__inner">
        <h2 className="dialog__title">{label}</h2>
        <p className="dialog__lead">
          改行をそのまま含められます。書き出し（CSV / TSV）でも改行は保たれます。
        </p>
        <textarea
          ref={textareaRef}
          className="dialog__textarea dialog__textarea--cell"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          aria-label={label}
        />
        <div className="dialog__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            完了
          </button>
        </div>
      </div>
    </dialog>
  );
}
