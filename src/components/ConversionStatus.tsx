import type { JSX } from 'react';
import type { ConversionActivity } from '../hooks/useConversion';

export interface ConversionStatusProps {
  activity: ConversionActivity | null;
  /** 変換が止まった理由（`describeConversionStop`）。次の変換か「閉じる」まで出したままにする。 */
  notice: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/**
 * 変換の進みと、止まったときの知らせ（issue #31）。どのタブにいても見えるよう上部に出す。
 *
 * 止まった理由はルールの直し方まで書くので長い。消えるトーストにすると読み切る前に消える。
 */
export function ConversionStatus({
  activity,
  notice,
  onCancel,
  onDismiss,
}: ConversionStatusProps): JSX.Element | null {
  if (activity) {
    return (
      <div className="conversion-status" role="status">
        <span className="conversion-status__text">
          変換しています（{activity.current} / {activity.total} ファイル）
        </span>
        <button type="button" className="btn btn--small" onClick={onCancel}>
          中止
        </button>
      </div>
    );
  }
  if (notice) {
    return (
      <div className="conversion-status conversion-status--error" role="alert">
        <span className="conversion-status__text">{notice}</span>
        <button type="button" className="btn btn--small" onClick={onDismiss}>
          閉じる
        </button>
      </div>
    );
  }
  return null;
}
