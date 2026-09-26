import { type JSX, useEffect, useRef } from 'react';
import { useScrollLock } from '../hooks/useScrollLock';
import { formatIndex, formatTextMeta } from '../lib/format';
import type { InputText } from '../types';
import { Icon } from './Icon';

/** lineHeight が取れない環境（テストや一部ブラウザ）で使う概算値。 */
const FALLBACK_LINE_HEIGHT = 30;

export interface EditorOverlayProps {
  input: InputText;
  index: number;
  total: number;
  /** プレビューから引き継ぐキャレット位置。 */
  initialCaret: number;
  /** キャレットが先頭のときだけ使う、プレビューのスクロール比率。 */
  initialScrollRatio: number;
  onChangeTitle: (title: string) => void;
  onChangeText: (text: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

/**
 * 入力テキストを全画面で編集するオーバーレイ。
 *
 * ネイティブの `<dialog>` を `showModal()` で開く。以前は `role="dialog"` を付けた
 * ただの div で、見た目はモーダルでも Tab で背面の要素へ抜けられ、`aria-modal` も
 * 背面の不活性化も無かった。ネイティブに寄せることで、フォーカストラップ・背面の
 * inert 化・Escape・閉じたあとの起点へのフォーカス復帰をブラウザに任せられる。
 */
export function EditorOverlay({
  input,
  index,
  total,
  initialCaret,
  initialScrollRatio,
  onChangeTitle,
  onChangeText,
  onPrev,
  onNext,
  onClose,
}: EditorOverlayProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useScrollLock();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // 開いた直後にプレビューで見ていた位置へ合わせる。テキストの変更では走らせない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いた対象が変わったときだけ位置を復元する
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(initialCaret, initialCaret);

    const lineHeight =
      Number.parseFloat(getComputedStyle(textarea).lineHeight) || FALLBACK_LINE_HEIGHT;
    const linesBefore = textarea.value.slice(0, initialCaret).split('\n').length - 1;
    const byLine = linesBefore * lineHeight - textarea.clientHeight / 3;
    textarea.scrollTop = Math.max(
      0,
      initialCaret ? byLine : initialScrollRatio * textarea.scrollHeight,
    );
  }, [input.id]);

  return (
    <dialog
      ref={dialogRef}
      className="editor"
      aria-label="本文の編集"
      onCancel={(event) => {
        // 既定の閉じ方だと React 側の状態が残るので、こちらで閉じる。
        event.preventDefault();
        onClose();
      }}
    >
      <div className="editor__head">
        <span className="editor__num">{formatIndex(index)}</span>
        <input
          className="cell-input editor__title"
          value={input.title}
          onChange={(event) => onChangeTitle(event.target.value)}
          placeholder="ファイル名"
          aria-label="ファイル名"
        />
        <button
          type="button"
          className="icon-btn icon-btn--bare editor__nav"
          onClick={onPrev}
          disabled={index <= 0}
          title="前のテキスト"
          aria-label="前のテキスト"
        >
          <Icon name="arrowUp" />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--bare editor__nav"
          onClick={onNext}
          disabled={index >= total - 1}
          title="次のテキスト"
          aria-label="次のテキスト"
        >
          <Icon name="arrowDown" />
        </button>
        <button type="button" className="editor__done" onClick={onClose}>
          完了
        </button>
      </div>
      <div className="editor__meta">
        <span className="editor__meta-main">{formatTextMeta(input.text)}</span>
        <span className="editor__meta-pos">
          {index + 1} / {total}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        className="editor__textarea"
        value={input.text}
        onChange={(event) => onChangeText(event.target.value)}
        placeholder="ここにテキストを入力・貼り付け"
        spellCheck={false}
        aria-label="本文"
      />
    </dialog>
  );
}
