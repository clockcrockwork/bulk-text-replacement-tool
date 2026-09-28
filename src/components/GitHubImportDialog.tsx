import {
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBeforeDeadline } from '../hooks/useBeforeDeadline';
import { formatTextMeta } from '../lib/format';
import { describeEntryStatus, describeGitHubError, formatBytes } from '../lib/githubApi';
import {
  BATCH_LIST_LIMIT,
  type BatchChoice,
  type BatchChoices,
  choiceToValue,
  chooseAddForUndecided,
  chooseSingleUpdates,
  countUndecided,
  type GitHubBatchDecision,
  initialBatchChoices,
  listPage,
  needsDecision,
  orderForReview,
  toBatchDecisions,
  UPDATE_TARGET_OPTION_LIMIT,
  updateTargetAt,
  valueToChoice,
  visibleUpdateTargets,
} from '../lib/githubBatchReview';
import {
  type BatchWarning,
  type GitHubSelectionMark,
  type GitHubTreeSelection,
  hasAnySelection,
  isPathSelected,
  planBatch,
  selectionMark,
  summarizeKnownSelection,
} from '../lib/githubSelection';
import {
  type BatchSourceMatch,
  type BatchUpdateTarget,
  formatSourceDetail,
  shortSha,
} from '../lib/inputSource';
import type { GitHubImportError, GitHubImportState } from '../state/githubImport';
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
  setSelected: (path: string, selected: boolean) => void;
  clearCandidate: () => void;
  prepareSelection: () => void;
  fetchBatch: () => void;
  clearBatch: () => void;
  close: () => void;
}

/** 候補と同じ取り込み元の既存入力。 */
export interface SameSourceInput {
  id: string;
  /** 「03 ch1.md」のように、入力タブで見える番号と名前。 */
  label: string;
}

/** 一括取り込みの候補1件の照合結果（`matchBatchSources` が作る）。 */
export type GitHubBatchMatch = BatchSourceMatch;

export type { GitHubBatchDecision } from '../lib/githubBatchReview';

interface GitHubImportDialogProps {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
  installUrl: string | null;
  /**
   * ブラウザへの保存に失敗しているか。
   * 認可は画面遷移を伴うので、保存できていない作業はそこで失われる。
   */
  saveFailed: boolean;
  sameSource: readonly SameSourceInput[];
  /** 候補と同じファイル名の、別の入力があるか。 */
  titleCollision: boolean;
  batchMatches: readonly GitHubBatchMatch[];
  onAdd: () => void;
  onUpdate: (inputId: string) => void;
  onApplyBatch: (decisions: readonly GitHubBatchDecision[]) => void;
}

/**
 * 失敗の知らせと、次に取れる手。
 *
 * rate limit のあいだは「再試行」を押せなくする（解除時刻になったら押せるように戻る）。
 * GitHub への要求そのものは hook の側でも止めているので、これは押せない理由を見せるため。
 */
function ErrorNotice({
  error,
  rateLimited,
  handlers,
}: {
  error: GitHubImportError;
  rateLimited: boolean;
  handlers: GitHubDialogHandlers;
}): JSX.Element {
  return (
    <div className="dialog__error github__error" role="alert">
      <span>{error.message}</span>
      {error.recover === 'retry' ? (
        <button
          type="button"
          className="btn btn--small"
          disabled={rateLimited}
          onClick={handlers.retry}
        >
          再試行
        </button>
      ) : null}
      {error.recover === 'reconnect' ? (
        <button type="button" className="btn btn--small" onClick={handlers.disconnect}>
          接続し直す
        </button>
      ) : null}
      {error.recover === 'dismiss' ? (
        <button type="button" className="btn btn--small" onClick={handlers.dismissError}>
          閉じる
        </button>
      ) : null}
    </div>
  );
}

/** 表示中の画面。フォーカスを移す目印に使う。 */
function viewKey(state: GitHubImportState): string {
  if (state.connection !== 'connected') return `consent:${state.connection}`;
  if (state.batchCandidates) return `batch:${state.batchCandidates.length}`;
  if (state.batchPlan) return `plan:${state.batchPlan.entries.length}`;
  if (state.candidate) return `candidate:${state.candidate.source.path}`;
  if (state.choosingBranch) return 'branches';
  if (state.snapshot) return `browse:${state.snapshot.commitSha}:${state.trail.at(-1)?.path ?? ''}`;
  if (state.repository) return 'repository';
  return 'repositories';
}

/**
 * 「GitHubから追加」。GitHub を読み取り専用の入力元として使う。
 *
 * 同意 → 接続 → リポジトリ → ブランチ（ここでコミットを固定）→ フォルダを辿って
 * 1ファイルを選ぶ → 内容を確かめて入力に追加、の順。タップだけで進められるよう、
 * 選択肢はすべてボタンの一覧にしている。
 */
export function GitHubImportDialog({
  state,
  handlers,
  installUrl,
  saveFailed,
  sameSource,
  titleCollision,
  batchMatches,
  onAdd,
  onUpdate,
  onApplyBatch,
}: GitHubImportDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const key = viewKey(state);
  const rateLimited = useBeforeDeadline(state.rateLimitedUntil);

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
            batchMatches={batchMatches}
            onAdd={onAdd}
            onUpdate={onUpdate}
            onApplyBatch={onApplyBatch}
          />
        ) : (
          <ConsentView
            state={state}
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
          <ErrorNotice error={state.error} rateLimited={rateLimited} handlers={handlers} />
        ) : rateLimited && state.rateLimitedUntil !== null ? (
          // 失敗の知らせは選択を変えるなどで消えるが、待ちは続く。押せないボタンの理由を残す。
          <p className="github__status" role="status">
            {describeGitHubError({
              kind: 'rateLimited',
              status: null,
              resetAt: state.rateLimitedUntil,
            })}
          </p>
        ) : null}

        {connected ? (
          // 解除で捨てるのは、このタブがメモリに持つアクセストークンだけ。GitHub 側の認可や
          // App のインストールまで取り消したと読まれないよう、ボタンの名前と補足で区別する。
          <p id="github-disconnect-note" className="github__disconnect-note">
            接続の解除はこのタブの中だけです。GitHub App に与えたアクセス権は、GitHub
            の設定から変更できます。
          </p>
        ) : null}

        <div className="dialog__actions">
          {connected ? (
            <button
              type="button"
              className="btn btn--quiet github__disconnect"
              aria-describedby="github-disconnect-note"
              onClick={handlers.disconnect}
            >
              このタブの接続を解除
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
  saveFailed: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onConnect: () => void;
}

/**
 * GitHub へ遷移する前の説明。何を許可し、何が起きないかを先に見せる。
 * GitHub の権限はリポジトリ単位なので、「選んだファイルだけ」の保証はこのアプリ側の約束になる。
 */
function ConsentView({ state, saveFailed, headingRef, onConnect }: ConsentViewProps): JSX.Element {
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
          このアプリが取得するのは、この画面で選んだ対応ファイル（.md / .txt / .tex）だけです。
        </li>
        <li>
          接続の資格情報は保存しません。再読み込みやタブを閉じたあとは、もう一度接続が必要です。
        </li>
        <li>
          取り込んだ本文は、手で追加した原稿と同じくこのブラウザの中に保存されます。
          リポジトリの内容がこのサイトのサーバーを経由することはありません。
        </li>
      </ul>
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
          disabled={connecting || saveFailed}
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
  batchMatches: readonly GitHubBatchMatch[];
  onAdd: () => void;
  onUpdate: (inputId: string) => void;
  onApplyBatch: (decisions: readonly GitHubBatchDecision[]) => void;
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
                  {candidate.owner}/{candidate.name}
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
      {state.batchCandidates ? (
        <BatchCandidateView {...props} candidates={state.batchCandidates} />
      ) : state.batchPlan ? (
        <BatchPlanView
          state={state}
          handlers={handlers}
          headingRef={headingRef}
          entries={state.batchPlan.entries}
        />
      ) : state.candidate ? (
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
          <dd>
            {repository.owner}/{repository.name}
          </dd>
        </div>
        {snapshot ? (
          <>
            <div>
              <dt>ブランチ</dt>
              <dd>{snapshot.ref}</dd>
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
      {state.candidate || state.batchPlan || state.batchCandidates ? null : (
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
                  <span className="github__entry-name">{name}</span>
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
  // rate limit のあいだは、GitHub へ要求するボタンを押せなくする（要求は hook の側でも止めている）。
  const rateLimited = useBeforeDeadline(state.rateLimitedUntil);
  const { trail, listing, snapshot, selection } = state;
  const here = trail[trail.length - 1];
  const rootLabel = snapshot?.repository.name ?? 'ルート';
  const [filter, setFilter] = useState('');

  // 絞り込みは表示だけに効かせる。場所を移ったら前の文字列を持ち越さない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 現在ディレクトリの変更だけを契機にリセットする
  useEffect(() => setFilter(''), [here?.path]);

  const visibleEntries = useMemo(() => {
    if (!listing) return [];
    const query = normalizeForFilter(filter.trim());
    if (!query) return listing.entries;
    return listing.entries.filter((entry) => normalizeForFilter(entry.name).includes(query));
  }, [listing, filter]);

  const known = useMemo(
    () => summarizeKnownSelection(selection, state.knownEntries.values()),
    [selection, state.knownEntries],
  );
  // 列挙の最中に選択を変えると、数えている一覧と画面の選択が食い違う。取得が終わるまで
  // 選択は変えさせない（止めたいときは閉じれば中断する）。
  const selectionLocked = state.busy !== null;

  return (
    <section className="github__section" aria-label="ファイルを選ぶ">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        ファイルを選ぶ
      </h3>
      <p className="dialog__lead">
        チェックは移動しても保持されます。フォルダをチェックすると、まだ開いていない配下も選択扱いになります。
      </p>
      <nav className="github__crumbs" aria-label="現在の場所">
        <ol>
          {trail.map((step, index) => {
            const label = index === 0 ? rootLabel : step.path.slice(step.path.lastIndexOf('/') + 1);
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

      <div className="github__picker-tools">
        {trail.length > 1 ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => handlers.goTo(trail.length - 2)}
          >
            <Icon name="up" size={14} />
            <span>上の階層へ</span>
          </button>
        ) : null}
        <label className="github__filter">
          <span className="sr-only">このフォルダを絞り込み</span>
          <input
            type="search"
            value={filter}
            placeholder="このフォルダを絞り込み"
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
      </div>

      <p className="github__selection-summary" aria-live="polite" aria-atomic="true">
        読み込み済み範囲で選択中: {known.files}ファイル · {known.directories}フォルダ
        {known.bytes > 0 ? ` · ${formatBytes(known.bytes)}` : ''}
        {filter ? '（絞り込みで隠れた選択は解除されません）' : ''}
      </p>

      {here ? (
        <div className="github__current-selection">
          <SelectionCheckbox
            mark={selectionMark(selection, here.path)}
            disabled={selectionLocked}
            onChange={(selected) => handlers.setSelected(here.path, selected)}
          >
            このフォルダ全体を選択
          </SelectionCheckbox>
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
        ) : visibleEntries.length === 0 ? (
          <p className="dialog__lead">一致する項目がありません。</p>
        ) : (
          <ul className="github__list" aria-label={here.path || rootLabel}>
            {visibleEntries.map((entry) => (
              <li key={entry.sha + entry.name}>
                <TreeEntryRow
                  entry={entry}
                  handlers={handlers}
                  selection={selection}
                  selectionLocked={selectionLocked}
                />
              </li>
            ))}
          </ul>
        )
      ) : null}

      <div className="github__selection-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={state.busy !== null || rateLimited || !hasAnySelection(selection)}
          onClick={handlers.prepareSelection}
        >
          選択したファイルを確認
        </button>
      </div>
    </section>
  );
}

/**
 * 3状態のチェックボックス。mixed はネイティブの `indeterminate` で表す（支援技術へも
 * そこから伝わるので `aria-checked` は付けない。付けると2つの値がずれ得る）。
 *
 * 見出しの文字がある場合は `<label>` の中に入れる。文字を押しても切り替わり、
 * 読み上げ名も表示と一致する。一覧の行のように文字が隣のボタンにある場合は `label` で名前を付ける。
 */
function SelectionCheckbox({
  mark,
  label,
  disabled,
  onChange,
  children,
}: {
  mark: GitHubSelectionMark;
  label?: string;
  disabled: boolean;
  onChange: (selected: boolean) => void;
  children?: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mark === 'mixed';
  }, [mark]);
  return (
    <label className="github__select-check">
      <input
        ref={ref}
        type="checkbox"
        checked={mark === 'checked'}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {children ? <span className="github__select-label">{children}</span> : null}
    </label>
  );
}

/**
 * 絞り込みの比較用。macOS で作られたリポジトリには NFD（「か」＋濁点）のファイル名が
 * 混じるが、入力欄に打つ文字は通常 NFC なので、比べるときだけ揃える。表示と出自の
 * パスには使わない（ファイル名そのものは変えない）。
 */
function normalizeForFilter(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

function TreeEntryRow({
  entry,
  handlers,
  selection,
  selectionLocked,
}: {
  entry: GitHubTreeEntry;
  handlers: GitHubDialogHandlers;
  selection: GitHubTreeSelection;
  selectionLocked: boolean;
}): JSX.Element {
  if (entry.status === 'dir') {
    const mark = selectionMark(selection, entry.path);
    return (
      <div className="github__select-row">
        <SelectionCheckbox
          mark={mark}
          label={`${entry.name} フォルダを選択`}
          disabled={selectionLocked}
          onChange={(selected) => handlers.setSelected(entry.path, selected)}
        />
        <button
          type="button"
          className="github__entry github__entry--dir"
          onClick={() => handlers.enterDirectory(entry)}
        >
          <Icon name="folder" size={16} />
          <span className="github__entry-name">{entry.name}/</span>
        </button>
      </div>
    );
  }
  if (entry.status === 'importable') {
    const selected = isPathSelected(selection, entry.path);
    return (
      <div className="github__select-row">
        <SelectionCheckbox
          mark={selected ? 'checked' : 'unchecked'}
          label={`${entry.name} を選択`}
          disabled={selectionLocked}
          onChange={(checked) => handlers.setSelected(entry.path, checked)}
        />
        <button type="button" className="github__entry" onClick={() => handlers.selectFile(entry)}>
          <Icon name="file" size={16} />
          <span className="github__entry-name">{entry.name}</span>
          {entry.size === null ? null : (
            <span className="github__entry-meta">{formatBytes(entry.size)}</span>
          )}
        </button>
      </div>
    );
  }
  // 選べない項目も隠さずに出す。「見当たらない」と「対象外」を区別できるように。
  return (
    <div className="github__entry is-disabled">
      <Icon name="file" size={16} />
      <span className="github__entry-name">{entry.name}</span>
      <span className="github__entry-meta">{describeEntryStatus(entry.status)}</span>
    </div>
  );
}

// ---- 複数取り込み：取得前の計画 ------------------------------------------------

function describeBatchWarning(warning: BatchWarning): string {
  switch (warning.kind) {
    case 'requests':
      // 一覧を数えるのに使った分は、この画面の時点で既に使っている。ここで示すのは、
      // このあと本文を取るために追加で使う回数（1ファイル1回）。
      return `このあと ${warning.files}ファイルの本文を取得するため、GitHub API をさらに ${warning.files}回使います。GitHub の利用上限は通常 1時間 5,000回で、使い切るとしばらく取り込めなくなります。`;
    case 'storage':
      return `合計 ${formatBytes(warning.bytes)} あります。ブラウザへの保存は数MBで打ち止めになるため、取り込んだあと保存に失敗する可能性があります。`;
    case 'unknownSize':
      return `${warning.files}件は大きさを事前に確認できません。表示している合計は下限で、実際にはもっと大きく、保存に失敗する可能性があります。`;
  }
}

/**
 * 列挙が終わり、blob を取る前の確認。まだ開いていないフォルダを選んだときは、
 * ここで初めて正確な件数と容量が分かる。取得には GitHub の利用上限を使うので、
 * 数字を見てから進めるようにする。
 */
function BatchPlanView({
  state,
  handlers,
  headingRef,
  entries,
}: {
  state: GitHubImportState;
  handlers: GitHubDialogHandlers;
  headingRef: RefObject<HTMLHeadingElement | null>;
  entries: readonly GitHubTreeEntry[];
}): JSX.Element {
  const rateLimited = useBeforeDeadline(state.rateLimitedUntil);
  const plan = useMemo(() => planBatch(entries), [entries]);
  return (
    <section className="github__section" aria-label="取り込むファイルの確認">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        {plan.files}ファイルが見つかりました
      </h3>
      <p className="dialog__lead">
        ファイルの本文はまだ取得していません。件数と容量を確かめてから取得してください。取得と検証が終わるまで入力テキストは変更されません。
      </p>
      <ul className="dialog__details">
        <li>
          合計 {formatBytes(plan.bytes)}
          {plan.unknownSizes > 0 ? `以上（${plan.unknownSizes}件は大きさ不明）` : ''}
        </li>
      </ul>
      {plan.warnings.length > 0 ? (
        <ul className="github__plan-warnings">
          {plan.warnings.map((warning) => (
            <li key={warning.kind}>{describeBatchWarning(warning)}</li>
          ))}
        </ul>
      ) : null}
      <ul className="github__plan-list" aria-label="取り込むファイル">
        {entries.slice(0, BATCH_LIST_LIMIT).map((entry) => (
          <li key={entry.path}>
            <span className="github__plan-path">{entry.path}</span>
            <span>{entry.size === null ? '大きさ不明' : formatBytes(entry.size)}</span>
          </li>
        ))}
      </ul>
      {entries.length > BATCH_LIST_LIMIT ? (
        <p className="github__list-more">ほか {entries.length - BATCH_LIST_LIMIT}件</p>
      ) : null}
      <div className="dialog__row">
        <button type="button" className="btn" onClick={handlers.clearBatch}>
          選択へ戻る
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={state.busy !== null || rateLimited}
          onClick={handlers.fetchBatch}
        >
          {plan.files}ファイルを取得
        </button>
      </div>
    </section>
  );
}

// ---- 複数取り込みの確認 --------------------------------------------------------

function BatchCandidateView({
  state,
  handlers,
  headingRef,
  candidates,
  batchMatches,
  onApplyBatch,
}: ConnectedViewProps & {
  candidates: NonNullable<GitHubImportState['batchCandidates']>;
}): JSX.Element {
  // 候補は数千件になり得るので、パスから引ける索引にしておく（行ごとに全体を探さない）。
  const candidateByPath = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.source.path, candidate])),
    [candidates],
  );
  const ordered = useMemo(
    () =>
      orderForReview(
        batchMatches,
        (match) =>
          match.titleCollision || candidateByPath.get(match.path)?.encoding === 'shift_jis',
      ),
    [batchMatches, candidateByPath],
  );
  // 同じ取り込み元が既にある候補は未決定から始め、利用者に選ばせる。
  const [choices, setChoices] = useState<BatchChoices>(() => initialBatchChoices(batchMatches));
  const undecided = countUndecided(batchMatches, choices);
  const needingDecision = batchMatches.filter(needsDecision);
  const singleTargets = needingDecision.filter(
    (match) => match.sameSource.length === 1 && !choices.has(match.path),
  ).length;
  const bytes = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
  const shiftJis = candidates.filter((candidate) => candidate.encoding === 'shift_jis').length;
  const [pageIndex, setPageIndex] = useState(0);
  const page = listPage(ordered.length, pageIndex);
  const shown = ordered.slice(page.start, page.end);
  const listRef = useRef<HTMLUListElement>(null);
  const rangeRef = useRef<HTMLParagraphElement>(null);

  /**
   * ページを送る。ページャは一覧の下にあるので、末尾までスクロールしてから押すのが自然で、
   * スクロール位置を残すと次のページが末尾から始まる。押したボタンは端のページで無効になり
   * フォーカスが外れるので、範囲の表示へ移す（行を入れ替える前に移しても、表示は残る）。
   */
  const goToPage = (index: number): void => {
    setPageIndex(index);
    if (listRef.current) listRef.current.scrollTop = 0;
    rangeRef.current?.focus();
  };

  /** まとめて決める。押したボタンは件数が 0 になると消えるので、フォーカスを見出しへ戻す。 */
  const decideAll = (decide: (current: BatchChoices) => BatchChoices): void => {
    setChoices(decide);
    headingRef.current?.focus();
  };

  const choose = (path: string, choice: BatchChoice | null): void => {
    setChoices((current) => {
      const next = new Map(current);
      if (choice) next.set(path, choice);
      else next.delete(path);
      return next;
    });
  };

  return (
    <section className="github__section" aria-label="複数ファイルの取り込み確認">
      <h3 ref={headingRef} className="github__heading" tabIndex={-1}>
        {candidates.length}ファイルを取り込む
      </h3>
      <p className="dialog__lead">
        全ファイルの取得と検証が終わりました。ここで確定するまで入力テキストは変更されません。
      </p>
      <ul className="dialog__details">
        <li>合計 {formatBytes(bytes)}</li>
        {shiftJis > 0 ? (
          <li>
            {shiftJis}件は Shift_JIS
            として読み込みました（推測）。この画面では本文を確認できないので、
            気になる場合は選択へ戻り、ファイル名を押して1件ずつ確認してください。
          </li>
        ) : null}
        {needingDecision.length > 0 ? (
          <li>
            {needingDecision.length}件は同じ取り込み元の入力があります
            {undecided > 0 ? `（未決定 ${undecided}件）` : ''}
          </li>
        ) : null}
      </ul>

      {undecided > 0 ? (
        // 数が多いと1件ずつ選ぶのは現実的でないので、推測を含まない範囲でまとめて決められるようにする。
        <div className="github__batch-bulk">
          {singleTargets > 0 ? (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => decideAll((current) => chooseSingleUpdates(batchMatches, current))}
            >
              更新先が1件の{singleTargets}件をすべて更新
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--small"
            onClick={() => decideAll((current) => chooseAddForUndecided(batchMatches, current))}
          >
            未決定の{undecided}件をすべて別の入力として追加
          </button>
        </div>
      ) : null}

      <ul ref={listRef} className="github__batch-list" aria-label="取り込むファイル">
        {shown.map((match) => {
          const candidate = candidateByPath.get(match.path);
          if (!candidate) return null;
          return (
            <li key={match.path} className="github__batch-item">
              <div className="github__batch-file">
                <strong>{match.path}</strong>
                <span>
                  {formatBytes(candidate.size)}
                  {candidate.encoding === 'shift_jis' ? ' · Shift_JIS' : ''}
                </span>
              </div>
              {match.titleCollision ? (
                <span className="github__batch-warning">
                  同じファイル名の別入力があります（別の取り込み元として扱います）
                </span>
              ) : null}
              {needsDecision(match) ? (
                <BatchDecision
                  match={match}
                  choice={choices.get(match.path)}
                  onChoose={(choice) => choose(match.path, choice)}
                />
              ) : (
                <span className="github__batch-new">新しい入力として追加</span>
              )}
            </li>
          );
        })}
      </ul>
      {page.count > 1 ? (
        <nav className="github__list-pager" aria-label="取り込むファイルの一覧のページ">
          <button
            type="button"
            className="btn btn--small"
            disabled={page.index === 0}
            onClick={() => goToPage(page.index - 1)}
          >
            前の{BATCH_LIST_LIMIT}件
          </button>
          <p ref={rangeRef} className="github__list-more" tabIndex={-1} aria-live="polite">
            {page.start + 1}〜{page.end}件目 / 全{ordered.length}
            件（判断が要るもの・注意が要るものを先に並べています）
          </p>
          <button
            type="button"
            className="btn btn--small"
            disabled={page.index === page.count - 1}
            onClick={() => goToPage(page.index + 1)}
          >
            次の{BATCH_LIST_LIMIT}件
          </button>
        </nav>
      ) : null}

      <div className="dialog__row">
        <button type="button" className="btn" onClick={handlers.clearBatch}>
          選択へ戻る
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={state.busy !== null || undecided > 0}
          onClick={() => onApplyBatch(toBatchDecisions(batchMatches, choices))}
        >
          {candidates.length}ファイルを取り込む
        </button>
      </div>
    </section>
  );
}

/**
 * 同じ取り込み元がある候補1件の取り込み方法。
 *
 * 更新先は「別の入力として追加」を繰り返した数だけあり得るので、選択欄に並べるのは先頭の
 * `UPDATE_TARGET_OPTION_LIMIT` 件だけにする。それを超える候補では、入力の一覧の番号でも
 * 更新先を指定できるようにし、どの更新先も選べることは保つ。
 */
function BatchDecision({
  match,
  choice,
  onChoose,
}: {
  match: BatchSourceMatch;
  choice: BatchChoice | undefined;
  onChoose: (choice: BatchChoice | null) => void;
}): JSX.Element {
  const chosenId = choice?.action === 'update' ? choice.inputId : null;
  const options = visibleUpdateTargets(match.sameSource, chosenId);
  const hidden = Math.max(0, match.sameSource.length - UPDATE_TARGET_OPTION_LIMIT);
  return (
    <div className="github__batch-decision">
      <label className="github__batch-decision-field">
        <span>同じ取り込み元があります</span>
        <select
          aria-label={`${match.path} の取り込み方法`}
          value={choiceToValue(choice)}
          onChange={(event) => onChoose(valueToChoice(event.currentTarget.value))}
        >
          <option value="">取り込み方法を選ぶ</option>
          <option value={choiceToValue({ action: 'add' })}>別の入力として追加</option>
          {options.map((target) => (
            <option key={target.id} value={choiceToValue({ action: 'update', inputId: target.id })}>
              {target.label} を更新
            </option>
          ))}
        </select>
      </label>
      {hidden > 0 ? (
        <UpdateTargetByNumber
          path={match.path}
          targets={match.sameSource}
          hidden={hidden}
          onChoose={(target) => onChoose({ action: 'update', inputId: target.id })}
        />
      ) : null}
    </div>
  );
}

/** 選択欄に並べきれない更新先を、入力の一覧の番号で指定する。 */
function UpdateTargetByNumber({
  path,
  targets,
  hidden,
  onChoose,
}: {
  path: string;
  targets: readonly BatchUpdateTarget[];
  hidden: number;
  onChoose: (target: BatchUpdateTarget) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="github__batch-target"
      onSubmit={(event) => {
        event.preventDefault();
        // 日本語入力のままだと全角数字で打たれやすいので、番号として読むときだけ半角にそろえる。
        const position = Number(value.normalize('NFKC'));
        const target = Number.isInteger(position) ? updateTargetAt(targets, position) : null;
        if (!target) {
          setMessage(`${value || '空欄'} はこのファイルから取り込んだ入力の番号ではありません`);
          return;
        }
        setMessage(null);
        onChoose(target);
      }}
    >
      <label className="github__batch-target-field">
        <span>ほかに{hidden}件あります。入力の番号で更新先を指定できます</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label={`${path} の更新先の入力の番号`}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value.trim())}
        />
      </label>
      <button type="submit" className="btn btn--small">
        この番号を更新
      </button>
      {message ? (
        <p className="github__batch-warning" role="alert">
          {message}
        </p>
      ) : null}
    </form>
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
        {candidate.title} を取り込む
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
              <span>{input.label}</span>
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
