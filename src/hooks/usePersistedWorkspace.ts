import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRecoverySnapshot } from '../lib/recoverySnapshot';
import {
  isForeignWorkspaceChange,
  isForeignWorkspaceValue,
  peekWorkspace,
  serializeWorkspace,
  writeSerializedWorkspace,
  writeWorkspace,
} from '../lib/storage';
import type { PersistedWorkspace } from '../types';

const SAVE_DEBOUNCE_MS = 400;

/**
 * 復旧画面（ErrorBoundary）から読む、保存データに入っていない最新の作業の控え。
 *
 * ErrorBoundary はアプリの外側にあって React の状態を読めないので、React の外に置く。
 * ページに App は1つしか無いので、モジュールに1つでよい。
 */
export const workspaceRecovery = createRecoverySnapshot();

export interface PersistedWorkspaceStatus {
  /** 直近の保存に失敗しているか。 */
  saveFailed: boolean;
  /**
   * 別のタブが作業データを書き換えたか。true の間は、このタブからは保存しない
   * （`overwrite` で解除するまで）。
   */
  conflict: boolean;
  /**
   * 保留中の分も含めて、いまの内容をその場で書き出す。成否を返す。
   *
   * 画面遷移（GitHub の認可など）の直前に呼ぶ。`saveFailed` は「最後に実行済みの保存」の
   * 結果でしかなく、デバウンス中の編集はまだ書かれていない。遷移の直前に確かめないと、
   * 書けないまま離れて、戻ってきたときに古い内容へ巻き戻る。
   * 別のタブとの食い違いがある間は書かずに false を返す（黙って上書きしない）。
   */
  flush: () => boolean;
  /**
   * 別のタブの内容を、このタブの内容で上書きして保存を再開する。成否を返す。
   * 利用者が「このタブの内容で続ける」を選んだときだけ呼ぶ。
   */
  overwrite: () => boolean;
  /**
   * いま保存できるか（保存に失敗しておらず、別のタブとの食い違いも無い）。await を挟んだ
   * 確定の直前に呼ぶ。描画中の `saveFailed` / `conflict` は、そのレンダーの時点の値でしかない。
   */
  canSave: () => boolean;
}

/**
 * 入力のたびに書くと重いので、少し待ってから localStorage に保存する。
 *
 * デバウンス中にタブを閉じると保留分が消えるため、ページが隠れる／破棄される
 * タイミングで即座に書き出す。`beforeunload` はモバイル Safari で発火しないことが
 * あるので `pagehide` と `visibilitychange` を見る。
 *
 * 同じオリジンの複数のタブは同じキーへ保存するので、後から書いた方が前の編集を黙って
 * 消す（issue #30）。`storage` イベントで他のタブの書き込みを検知したら、このタブの
 * 保存を止めて `conflict` を返す。どちらを正とするかは利用者に選んでもらう
 * （自動で merge しない・どちらかを勝手に正にしない）。
 */
export function usePersistedWorkspace(workspace: PersistedWorkspace): PersistedWorkspaceStatus {
  const { inputs, groups, rules, theme, isSample } = workspace;

  // 復旧用の控えは**レンダー中に**更新する。描画が落ちた状態は commit されないので、
  // effect で更新すると、落ちる原因になった最新の操作が控えに入らない。破棄された
  // レンダーの値が残り得るが、救う対象としては「最後に描こうとした内容」で正しい
  // （保存に使う `latest` とは目的が違う）。
  workspaceRecovery.noteRendered({ inputs, groups, rules, theme, isSample });
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    // 起動時の状態は保存データから読んだもの（無ければ初回サンプル）。
    workspaceRecovery.noteSaved({ inputs, groups, rules, theme, isSample });
  }

  /**
   * 直近の値。離れるとき（pagehide / visibilitychange）に依存配列を気にせず取り出す。
   * レンダー中に書くと、破棄されたレンダー（Strict Mode の二重呼び出しや中断された
   * 並行レンダー）の値が残りうるので、コミット後に更新する。
   * 更新は layout effect で行う。passive effect（useEffect）は「次の利用者操作より先に
   * 済んでいる」保証が無く、編集の直後にタブを閉じると1つ前の内容を書き得るため。
   */
  const latest = useRef(workspace);
  /**
   * 保存データはこれのはず、とこのタブが分かっている値。保存の直前と `storage` イベントで
   * 今の値と比べ、知らない値なら他のタブが書いた（消した）とみなす。
   *
   * 書いたあとは書いた文字列だけ。起動時は、読んだ生の文字列と、読み込んだ状態を今の形で
   * 保存し直した文字列の両方。生の文字列だけだと、古い版の形（キーの順・欠けた項目）で
   * 保存されていたとき、同じデータを開いた別のタブが今の形に書き直しただけで食い違いになる。
   */
  const [initialKnown] = useState<readonly (string | null)[]>(() => [
    peekWorkspace()?.raw ?? null,
    serializeWorkspace({ inputs, groups, rules, theme, isSample }),
  ]);
  const known = useRef(initialKnown);
  /**
   * 直近の保存に失敗しているか。
   *
   * 失敗を握り潰すと、保存されないまま編集が続き、リロードした時点でその間の
   * 作業が消える。消えるトーストではなく、直るまで出したままにできるよう
   * 状態として返す。ref は `canSave` が読む（await のあとの古いレンダーからも最新を見る）。
   */
  const [failed, setFailed] = useState(false);
  const failedRef = useRef(false);
  /**
   * 別のタブとの食い違い。ref は離れるときの保存とデバウンスの保存が読む
   * （どちらも依存配列の外から呼ばれる）。
   */
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);

  // 以下の関数が読むのは ref と state の setter だけなので、どのレンダーで作っても振る舞いは同じ。

  const enterConflict = useCallback((): void => {
    conflictRef.current = true;
    setConflict(true);
    // 保存データはもうこのタブの内容ではない。落ちたときは最新の状態を救う。
    workspaceRecovery.forgetSaved();
  }, []);

  /**
   * 保存データを読み直し、他のタブが書いていたら食い違いへ移る。
   *
   * `storage` イベントは非同期に届くので、他のタブが書いた直後、イベントが届く前に
   * このタブが保存すると、相手の編集を黙って上書きする（レビュー R1）。書く直前に読み直す。
   * 読み直しと書き込みは1つの同期処理の中で続けて行うが、タブをまたいで原子的ではない。
   * その隙間で2つのタブが同時に書いた場合も、互いの書き込みの `storage` イベントが相手に
   * 届くので、両方のタブが食い違いの警告になる（どちらかが黙って負けることはない）。
   */
  const detectForeignWrite = useCallback((): boolean => {
    if (conflictRef.current) return true;
    const current = peekWorkspace();
    // 読めないなら判定できない。書き込みも失敗するので、保存失敗として出る。
    if (current === null || !isForeignWorkspaceValue(current.raw, known.current)) return false;
    enterConflict();
    return true;
  }, [enterConflict]);

  /** 書き出して、成否を状態に反映する。 */
  /** 書いた結果を状態に反映する。 */
  const settle = useCallback((value: PersistedWorkspace, raw: string | null): boolean => {
    failedRef.current = raw === null;
    setFailed(raw === null);
    if (raw === null) return false;
    known.current = [raw];
    workspaceRecovery.noteSaved(value);
    return true;
  }, []);

  /** 書き出して、成否を状態に反映する。 */
  const write = useCallback(
    (value: PersistedWorkspace): boolean => settle(value, writeWorkspace(value)),
    [settle],
  );

  /**
   * 通常の保存。食い違いがある間・他のタブが書いていたら書かない。
   *
   * 書く内容が、保存データにあると分かっている値（`known`）と同じなら書かない。書いても
   * 中身は変わらず、かえって別のタブを食い違いにする。保存データが空のまま2つのタブを同時に
   * 開くと、どちらも手つかずのサンプル（ID は乱数）を起動直後に保存し、互いに相手を
   * 「別のタブで更新された」と判定していた（レビュー）。
   */
  const save = useCallback(
    (value: PersistedWorkspace): boolean => {
      if (detectForeignWrite()) return false;
      const raw = serializeWorkspace(value);
      if (known.current.includes(raw)) {
        // 書いていないので、保存データは知っている値のどれか（古い形のままのこともある）。
        // `known` は置き換えない。置き換えると、残っている古い形の値を知らない値と見なして
        // 自分で食い違いにする。
        failedRef.current = false;
        setFailed(false);
        workspaceRecovery.noteSaved(value);
        return true;
      }
      return settle(value, writeSerializedWorkspace(raw) ? raw : null);
    },
    [detectForeignWrite, settle],
  );

  useLayoutEffect(() => {
    latest.current = { inputs, groups, rules, theme, isSample };
  }, [inputs, groups, rules, theme, isSample]);

  useEffect(() => {
    const timer = setTimeout(() => {
      save({ inputs, groups, rules, theme, isSample });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [save, inputs, groups, rules, theme, isSample]);

  /**
   * イベントハンドラから呼ぶ書き出し。このレンダーの値そのものを閉じ込めて書く。
   *
   * `latest.current` は effect（コミット後）で更新するので、「次の利用者操作より先に
   * effect が済んでいる」ことに頼ると、1つ前の内容を成功として書いて画面を離れ得る。
   * ハンドラはそれを描いたレンダーの関数なので、そのレンダーの値が利用者の見ている内容。
   */
  const flush = (): boolean => save({ inputs, groups, rules, theme, isSample });

  /** 利用者が選んだ上書き。他のタブの値を承知で書くので、読み直さずに書く。 */
  const overwrite = (): boolean => {
    conflictRef.current = false;
    setConflict(false);
    // 別のタブの値は承知のうえで上書きする。書けなかったとき（容量超過）に、次の保存で
    // その値を「知らない値」と見て食い違いの警告へ戻らないよう、先に知っている値にする。
    const current = peekWorkspace();
    if (current) known.current = [current.raw];
    return write({ inputs, groups, rules, theme, isSample });
  };

  /**
   * いま保存できるか。確認ダイアログなどを await したあと、確定する直前に呼ぶ
   * （レビュー R3）。待っている間に別のタブが保存したり保存に失敗したりしても、
   * 呼び出し元のレンダーの値は古いまま。ref と保存データの読み直しで最新を見る。
   */
  const canSave = (): boolean => !failedRef.current && !detectForeignWrite();

  useEffect(() => {
    const flushOnLeave = (): void => {
      save(latest.current);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushOnLeave();
    };
    const onStorage = (event: StorageEvent): void => {
      if (conflictRef.current) return;
      if (isForeignWorkspaceChange(event, known.current)) enterConflict();
    };
    window.addEventListener('pagehide', flushOnLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('pagehide', flushOnLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [save, enterConflict]);

  return { saveFailed: failed, conflict, flush, overwrite, canSave };
}
