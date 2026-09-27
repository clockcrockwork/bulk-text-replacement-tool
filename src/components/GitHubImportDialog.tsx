import { type JSX, type RefObject, useEffect, useRef, useState } from 'react';
import { formatTextMeta } from '../lib/format';
import { describeEntryStatus, formatBytes } from '../lib/githubApi';
import { formatSourceDetail, shortSha } from '../lib/inputSource';
import { revealUnsafeChars as reveal } from '../lib/revealText';
import type { GitHubImportState } from '../state/githubImport';
import type { GitHubRepository, GitHubTreeEntry } from '../types';
import { Icon } from './Icon';

/** ダイアログから呼ぶ操作。通信と状態はフック（`useGitHubImport`）が持つ。 */
export interface GitHubDialogHandlers {
  connect: () => void;
  disconnect: () => void;
  retry: () => void;
  dismissError: () => void;
  reloadRepositories: () => void;
  selectRepository: (repository: GitHubRepository) => void;
  clearRepository: () => void;
  showBranches: () => void;
  hideBranches: () => void;
  selectBranch: (ref: string) => void;
  refreshSnapshot: () => void;
  enterDirectory: (entry: GitHubTreeEntry) => void;
  goTo: (index: number) => void;
  selectFile: (entry: GitHubTreeEntry) => void;
  clearCandidate: () => void;
  close: () => void;
}

/** 候補と同じ取り込み元の既存入力。 */
export interface SameSourceInput {
  id: string;
  /** 「03 ch1.md」のように、入力タブで見える番号と名前。 */
  label: string;
}

interface GitHubImportDialogProps {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
  installUrl: string | null;
  /** 正規でないオリジンで開かれているとき、正規のオリジンの URL（`useGitHubImport`）。 */
  canonicalUrl: string | null;
  /**
   * ブラウザへの保存に失敗しているか。
   * 認可は画面遷移を伴うので、保存できていない作業はそこで失われる。
   */
  saveFailed: boolean;
  sameSource: readonly SameSourceInput[];
  /** 候補と同じファイル名の、別の入力があるか。 */
  titleCollision: boolean;
  onAdd: () => void;
  onUpdate: (inputId: string) => void;
}

/** 表示中の画面。フォーカスを移す目印に使う。 */
function viewKey(state: GitHubImportState): string {
  if (state.connection !== 'connected') return `consent:${state.connection}`;
  if (state.candidate) return `candidate:${state.candidate.source.path}`;
  if (state.choosingBranch) return 'branches';
  if (state.snapshot) return `browse:${state.snapshot.commitSha}:${state.trail.length}`;
  if (state.repository) return 'repository';
  return 'repositories';
}

/**
 * 「GitHubから追加」。GitHub を読み取り専用の入力元として使う。
 *
 * 同意 → 接続 → リポジトリ → ブランチ（ここでコミットを固定）→ フォルダを辿って
 * 1ファイルを選ぶ → 内容を確かめて入力に追加、の順。タップだけで進められるよう、
 * 選択肢はすべてボタンの一覧にしている。
 *
 * GitHub から来た名前（リポジトリ・ブランチ・パス・ファイル名）は `reveal` を通して描画する。
 * 双方向制御文字をそのまま出すと、一覧の見た目と違うファイルを選ばせる偽装ができる。
 * 変えるのは表示だけで、選んだ項目・出自・タイトルは元の文字列のまま扱う。
 */
export function GitHubImportDialog({
  state,
  handlers,
  installUrl,
  canonicalUrl,
  saveFailed,
  sameSource,
  titleCollision,
  onAdd,
  onUpdate,
}: GitHubImportDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const key = viewKey(state);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // 画面が切り替わると押したボタンが消えるので、見出しへフォーカスを移して
  // キーボードとスクリーンリーダーの位置を失わせない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 画面の切り替わり（key）だけを契機にする
  useEffect(() => {
    headingRef.current?.focus();
  }, [key]);

  const connected = state.connection === 'connected';

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでの閉じる操作は <dialog> 標準の Escape（onCancel）が担う
    <dialog
      ref={dialogRef}
      className="dialog dialog--github"
      aria-label="GitHubから追加"
      onCancel={(event) => {
        event.preventDefault();
        handlers.close();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) handlers.close();
      }}
    >
      <div className="dialog__inner">
        <h2 className="dialog__title">GitHubから追加</h2>

        {connected ? (
          <ConnectedView
            state={state}
            handlers={handlers}
            installUrl={installUrl}
            headingRef={headingRef}
            sameSource={sameSource}
            titleCollision={titleCollision}
            onAdd={onAdd}
            onUpdate={onUpdate}
          />
        ) : (
          <ConsentView
            state={state}
            canonicalUrl={canonicalUrl}
            saveFailed={saveFailed}
            headingRef={headingRef}
            onConnect={handlers.connect}
          />
        )}

        {state.busy ? (
          <p className="github__status" role="status">
            {state.busy}…
          </p>
        ) : null}

        {state.info ? (
          <p className="github__status" role="status">
            {state.info}
          </p>
        ) : null}

        {state.error ? (
          <div className="dialog__error github__error" role="alert">
            <span>{state.error.message}</span>
            {state.error.recover === 'retry' ? (
              <button type="button" className="btn btn--small" onClick={handlers.retry}>
                再試行
              </button>
            ) : null}
            {state.error.recover === 'reconnect' ? (
              <button type="button" className="btn btn--small" onClick={handlers.disconnect}>
                接続し直す
              </button>
            ) : null}
            {state.error.recover === 'dismiss' ? (
              <button type="button" className="btn btn--small" onClick={handlers.dismissError}>
                閉じる
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="dialog__actions">
          {connected ? (
            <button
              type="button"
              className="btn btn--quiet github__disconnect"
              onClick={handlers.disconnect}
            >
              接続を解除
            </button>
          ) : null}
          <button type="button" className="btn" onClick={handlers.close}>
            閉じる
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ---- 同意 ---------------------------------------------------------------------

interface ConsentViewProps {
  state: GitHubImportState;
  canonicalUrl: string | null;
  saveFailed: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onConnect: () => void;
}

/**
 * GitHub へ遷移する前の説明。何を許可し、何が起きないかを先に見せる。
 * GitHub の権限はリポジトリ単位なので、「選んだファイルだけ」の保証はこのアプリ側の約束になる。
 */
function ConsentView({
  state,
  canonicalUrl,
  saveFailed,
  headingRef,
  onConnect,
}: ConsentViewProps): JSX.Element {
  const connecting = state.connection === 'connecting';
  return (
    <section className="github__consent" aria-label="GitHub との接続">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        {connecting ? 'GitHub に接続しています' : '接続する前に'}
      </h3>
      {state.notice ? (
        <p className="dialog__error" role="alert">
          {state.notice}
        </p>
      ) : null}
      <ul className="dialog__details github__promises">
        <li>読み取り専用です。コミット・push・Pull Request・自動同期は行いません。</li>
        <li>
          GitHub での許可は<strong>リポジトリ単位</strong>です（ファイル単位ではありません）。
          どのリポジトリを許可するかは GitHub の画面で選びます。
        </li>
        <li>
          一覧を出すために、許可したリポジトリ・ブランチ・フォルダの情報（名前・コミット・一覧）を取得します。
          <strong>本文を取得するのは、この画面で選んだファイルだけ</strong>
          です（対応形式は .md / .txt / .tex）。
        </li>
        <li>
          接続の資格情報は保存しません。再読み込みやタブを閉じたあとは、もう一度接続が必要です。
        </li>
        <li>
          取り込んだ本文は、手で追加した原稿と同じくこのブラウザの中に保存されます。
          リポジトリの内容がこのサイトのサーバーを経由することはありません。
        </li>
        <li>
          取り込んだ入力には、取り込み元（owner/repo・ブランチ・パス・コミットの SHA）も記録します。
          これはこのブラウザ（localStorage）に保存され、作業データの書き出しにも含まれます。
        </li>
      </ul>
      {canonicalUrl ? (
        <div className="dialog__error github__origin" role="alert">
          <p>
            このアドレスでは GitHub に接続できません。GitHub App に登録してある
            正規のアドレスで開き直してください。
          </p>
          <p>
            <a href={canonicalUrl} target="_blank" rel="noreferrer">
              {canonicalUrl} を開く
            </a>
          </p>
          <p>
            作業データはアドレスごとにブラウザへ保存されるため、移った先には引き継がれません。
            必要なら先に作業データを書き出してください。
          </p>
        </div>
      ) : null}
      {saveFailed ? (
        <p className="dialog__error" role="alert">
          いまブラウザへの保存に失敗しています。接続では GitHub の画面へ移動するため、
          保存できていない作業が失われます。先に作業データを書き出してください。
        </p>
      ) : null}
      <div className="dialog__row">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onConnect}
          disabled={connecting || saveFailed || canonicalUrl !== null}
        >
          <Icon name="branch" size={15} />
          <span>GitHubに接続</span>
        </button>
      </div>
    </section>
  );
}

// ---- 接続後 -------------------------------------------------------------------

interface ConnectedViewProps {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
  installUrl: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  sameSource: readonly SameSourceInput[];
  titleCollision: boolean;
  onAdd: () => void;
  onUpdate: (inputId: string) => void;
}

function ConnectedView(props: ConnectedViewProps): JSX.Element | null {
  const { state, handlers, installUrl, headingRef } = props;

  if (state.repositories === null) return null;

  if (state.repositories.length === 0) {
    return (
      <section className="github__section" aria-label="インストール">
        <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
          アクセスできるリポジトリがありません
        </h3>
        <p className="dialog__lead">
          GitHub App がまだインストールされていないか、読み取りを許可したリポジトリがありません。
          GitHub
          の画面でインストールし、取り込みたいリポジトリを選んでから「再確認」を押してください。
          Organization では管理者の承認待ちになることがあります。
        </p>
        <div className="dialog__row">
          {installUrl ? (
            <a className="btn btn--primary" href={installUrl} target="_blank" rel="noreferrer">
              GitHub Appをインストール / 権限を設定
            </a>
          ) : null}
          <button type="button" className="btn" onClick={handlers.reloadRepositories}>
            <Icon name="refresh" size={15} />
            <span>再確認</span>
          </button>
        </div>
      </section>
    );
  }

  const repository = state.repository;
  if (!repository) {
    return (
      <section className="github__section" aria-label="リポジトリ">
        <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
          リポジトリを選ぶ
        </h3>
        <ul className="github__list">
          {state.repositories.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className="github__entry"
                onClick={() => handlers.selectRepository(candidate)}
              >
                <span className="github__entry-name">
                  {reveal(`${candidate.owner}/${candidate.name}`)}
                </span>
                {candidate.private ? <span className="tag">private</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {installUrl ? (
          <p className="dialog__lead">
            一覧に無いリポジトリは、
            <a href={installUrl} target="_blank" rel="noreferrer">
              GitHub App の設定
            </a>
            で読み取りを許可してから
            <button type="button" className="btn btn--quiet" onClick={handlers.reloadRepositories}>
              再確認
            </button>
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <RepositoryContext state={state} handlers={handlers} />
      {state.candidate ? (
        <CandidateView {...props} candidate={state.candidate} />
      ) : state.choosingBranch || !state.snapshot ? (
        <BranchList state={state} handlers={handlers} headingRef={headingRef} />
      ) : (
        <Explorer state={state} handlers={handlers} headingRef={headingRef} />
      )}
    </>
  );
}

/** いま見ているリポジトリ・ブランチ・固定したコミット。どの時点の内容かを常に見せる。 */
function RepositoryContext({
  state,
  handlers,
}: {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
}): JSX.Element | null {
  const { repository, snapshot } = state;
  if (!repository) return null;
  return (
    <div className="github__context">
      <dl className="github__facts">
        <div>
          <dt>リポジトリ</dt>
          <dd>{reveal(`${repository.owner}/${repository.name}`)}</dd>
        </div>
        {snapshot ? (
          <>
            <div>
              <dt>ブランチ</dt>
              <dd>{reveal(snapshot.ref)}</dd>
            </div>
            <div>
              <dt>固定したコミット</dt>
              <dd>
                <code title={snapshot.commitSha}>{shortSha(snapshot.commitSha)}</code>
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {state.candidate ? null : (
        <div className="github__context-actions">
          {snapshot && !state.choosingBranch ? (
            <>
              <button type="button" className="btn btn--small" onClick={handlers.showBranches}>
                <Icon name="branch" size={14} />
                <span>ブランチを変更</span>
              </button>
              <button type="button" className="btn btn--small" onClick={handlers.refreshSnapshot}>
                <Icon name="refresh" size={14} />
                <span>最新に更新</span>
              </button>
            </>
          ) : null}
          <button type="button" className="btn btn--small" onClick={handlers.clearRepository}>
            リポジトリを選び直す
          </button>
        </div>
      )}
    </div>
  );
}

function BranchList({
  state,
  handlers,
  headingRef,
}: {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
  headingRef: RefObject<HTMLHeadingElement | null>;
}): JSX.Element {
  const current = state.snapshot?.ref;
  const defaultBranch = state.repository?.defaultBranch;
  return (
    <section className="github__section" aria-label="ブランチ">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        ブランチを選ぶ
      </h3>
      <p className="dialog__lead">選んだ時点の最新コミットに固定して開きます。</p>
      {state.branches ? (
        state.branches.length === 0 ? (
          <p className="dialog__lead">ブランチがありません。</p>
        ) : (
          <ul className="github__list">
            {state.branches.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="github__entry"
                  aria-current={name === current ? 'true' : undefined}
                  onClick={() => handlers.selectBranch(name)}
                >
                  <Icon name="branch" size={15} />
                  <span className="github__entry-name">{reveal(name)}</span>
                  {name === defaultBranch ? <span className="tag">既定</span> : null}
                  {name === current ? <span className="tag">表示中</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {state.snapshot ? (
        <div className="dialog__row">
          <button type="button" className="btn btn--small" onClick={handlers.hideBranches}>
            ブランチを変えずに戻る
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Explorer({
  state,
  handlers,
  headingRef,
}: {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
  headingRef: RefObject<HTMLHeadingElement | null>;
}): JSX.Element {
  const { trail, listing, snapshot } = state;
  const here = trail[trail.length - 1];
  const rootLabel = snapshot?.repository.name ?? 'ルート';
  return (
    <section className="github__section" aria-label="ファイルを選ぶ">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        ファイルを選ぶ
      </h3>
      <nav className="github__crumbs" aria-label="現在の場所">
        <ol>
          {trail.map((step, index) => {
            const label = reveal(
              index === 0 ? rootLabel : step.path.slice(step.path.lastIndexOf('/') + 1),
            );
            const last = index === trail.length - 1;
            return (
              <li key={step.path || '/'}>
                <button
                  type="button"
                  className="github__crumb"
                  aria-current={last ? 'location' : undefined}
                  disabled={last}
                  onClick={() => handlers.goTo(index)}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {trail.length > 1 ? (
        <div className="dialog__row">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => handlers.goTo(trail.length - 2)}
          >
            <Icon name="up" size={14} />
            <span>上の階層へ</span>
          </button>
        </div>
      ) : null}

      {listing?.truncated ? (
        <p className="dialog__error" role="alert">
          このフォルダは項目が多すぎるため、GitHub が一覧を途中で打ち切りました。
          表示されていないファイルがあります。
        </p>
      ) : null}

      {listing && here ? (
        listing.entries.length === 0 ? (
          <p className="dialog__lead">このフォルダには何もありません。</p>
        ) : (
          <ul className="github__list" aria-label={reveal(here.path || rootLabel)}>
            {listing.entries.map((entry) => (
              <li key={entry.sha + entry.name}>
                <TreeEntryRow entry={entry} handlers={handlers} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function TreeEntryRow({
  entry,
  handlers,
}: {
  entry: GitHubTreeEntry;
  handlers: GitHubDialogHandlers;
}): JSX.Element {
  if (entry.status === 'dir') {
    return (
      <button
        type="button"
        className="github__entry github__entry--dir"
        onClick={() => handlers.enterDirectory(entry)}
      >
        <Icon name="folder" size={16} />
        <span className="github__entry-name">{reveal(entry.name)}/</span>
      </button>
    );
  }
  if (entry.status === 'importable') {
    return (
      <button type="button" className="github__entry" onClick={() => handlers.selectFile(entry)}>
        <Icon name="file" size={16} />
        <span className="github__entry-name">{reveal(entry.name)}</span>
        {entry.size === null ? null : (
          <span className="github__entry-meta">{formatBytes(entry.size)}</span>
        )}
      </button>
    );
  }
  // 選べない項目も隠さずに出す。「見当たらない」と「対象外」を区別できるように。
  return (
    <div className="github__entry is-disabled">
      <Icon name="file" size={16} />
      <span className="github__entry-name">{reveal(entry.name)}</span>
      <span className="github__entry-meta">{describeEntryStatus(entry.status)}</span>
    </div>
  );
}

// ---- 取り込みの確認 ------------------------------------------------------------

function CandidateView({
  state,
  handlers,
  headingRef,
  candidate,
  sameSource,
  titleCollision,
  onAdd,
  onUpdate,
}: ConnectedViewProps & {
  candidate: NonNullable<GitHubImportState['candidate']>;
}): JSX.Element {
  // 更新先が1つに決まるときだけ選んでおく。複数あるときは推測しない。
  const [target, setTarget] = useState<string | null>(
    sameSource.length === 1 ? (sameSource[0]?.id ?? null) : null,
  );
  const busy = state.busy !== null;

  return (
    <section className="github__section" aria-label="取り込む内容の確認">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        {reveal(candidate.title)} を取り込む
      </h3>
      <ul className="dialog__details">
        <li>{formatSourceDetail(candidate.source)}</li>
        <li>
          {formatBytes(candidate.size)} · {formatTextMeta(candidate.text)}
        </li>
      </ul>
      {candidate.encoding === 'shift_jis' ? (
        <p className="dialog__error" role="alert">
          UTF-8 として読めなかったため、Shift_JIS として読み込みました。
          文字化けしていないか確認してください。
        </p>
      ) : null}
      <textarea
        className="dialog__textarea github__preview"
        readOnly
        value={candidate.text}
        aria-label="取り込む本文"
        spellCheck={false}
      />

      {titleCollision ? (
        <p className="dialog__lead">
          同じファイル名の入力が別にあります（取り込み元が違うので別の入力として扱います）。
          出力のファイル名は自動で振り分けます。
        </p>
      ) : null}

      {sameSource.length > 0 ? (
        <fieldset className="github__targets">
          <legend className="github__legend">
            {sameSource.length === 1
              ? 'このファイルは取り込み済みです'
              : `このファイルから取り込んだ入力が${sameSource.length}件あります。更新する入力を選んでください`}
          </legend>
          {sameSource.map((input) => (
            <label key={input.id} className="github__target">
              <input
                type="radio"
                name="github-update-target"
                value={input.id}
                checked={target === input.id}
                onChange={() => setTarget(input.id)}
              />
              <span>{reveal(input.label)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="dialog__actions github__decision">
        {/* 取り込み済みのときは「更新 / 別の入力として追加 / キャンセル」の3択として見せる。 */}
        <button type="button" className="btn" onClick={handlers.clearCandidate} disabled={busy}>
          {sameSource.length > 0 ? 'キャンセル' : '戻る'}
        </button>
        {sameSource.length > 0 ? (
          <>
            <button type="button" className="btn" onClick={onAdd} disabled={busy}>
              別の入力として追加
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || target === null}
              onClick={() => {
                if (target) onUpdate(target);
              }}
            >
              更新する
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onAdd} disabled={busy}>
            入力に追加
          </button>
        )}
      </div>
    </section>
  );
}
