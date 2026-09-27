import {
  type ChangeEvent,
  type DragEvent,
  type JSX,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AppHeader } from './components/AppHeader';
import { type BackupCandidate, BackupDialog } from './components/BackupDialog';
import { CellEditor } from './components/CellEditor';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { DropOverlay } from './components/DropOverlay';
import { EditorOverlay } from './components/EditorOverlay';
import { ImportDialog } from './components/ImportDialog';
import { InputPanel } from './components/InputPanel';
import { OutputPanel } from './components/OutputPanel';
import { RulesPanel } from './components/RulesPanel';
import {
  type GroupHandlers,
  type RuleHandlers,
  srcCellLabel,
  valueCellLabel,
} from './components/ruleTypes';
import { TabBar, type TabDescriptor } from './components/TabBar';
import { Toast } from './components/Toast';
import { useConfirm } from './hooks/useConfirm';
import { useNarrowScreen } from './hooks/useNarrowScreen';
import { usePersistedWorkspace } from './hooks/usePersistedWorkspace';
import { useToast } from './hooks/useToast';
import { buildBackup, parseBackup } from './lib/backup';
import { copyText, downloadBlob } from './lib/browser';
import { collectRuleErrors, findUnmatchedRules } from './lib/diagnostics';
import { timestampForFileName } from './lib/format';
import { readInputFiles } from './lib/inputFiles';
import { runConversion } from './lib/replace';
import {
  buildRulesFromTable,
  type Delimiter,
  findRaggedRows,
  parseTable,
  rulesToDelimited,
} from './lib/table';
import { decodeText, withBom } from './lib/text';
import { createZip } from './lib/zip';
import {
  createEmptyRule,
  createGroup,
  createInput,
  initWorkspace,
  workspaceReducer,
  workspaceSignature,
} from './state/workspace';
import type { PersistedWorkspace, ResultFile, RuleOrder } from './types';

/** エディタを閉じたとき、元のカードがヘッダーに隠れないよう空ける余白。 */
const SCROLL_BACK_OFFSET = 130;

/** ドラッグ中の DataTransfer にファイルが含まれるか。テキスト選択のドラッグを無視する。 */
function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer.types ?? [])].includes('Files');
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initWorkspace);
  const { message: toast, flash } = useToast();
  const confirm = useConfirm();
  const narrow = useNarrowScreen();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tableFileInputRef = useRef<HTMLInputElement>(null);
  /** dragenter / dragleave が子要素でも飛ぶので、深さを数えて判定する。 */
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const saveFailed = usePersistedWorkspace(state);

  // ---- 作業データ（バックアップ） --------------------------------------------
  const [backupOpen, setBackupOpen] = useState(false);
  /**
   * 読み込んだファイルの検証結果と、検証を通った中身。
   *
   * 「検証 → 内容を確認 → 反映」の順にするため、確定するまで現在の状態には触れない。
   * 選んだ瞬間に反映すると、壊れたファイルを選んだだけで今のデータが消え、
   * 復旧手段そのものが新しいデータ消失の経路になる。
   */
  const [backupCandidate, setBackupCandidate] = useState<BackupCandidate | null>(null);
  const [pendingWorkspace, setPendingWorkspace] = useState<PersistedWorkspace | null>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);

  const openBackup = (): void => {
    setBackupCandidate(null);
    setPendingWorkspace(null);
    setBackupOpen(true);
  };

  const closeBackup = (): void => {
    setBackupOpen(false);
    setBackupCandidate(null);
    setPendingWorkspace(null);
  };

  const exportBackup = (): void => {
    guard('作業データの書き出し', () => {
      const at = new Date();
      const { inputs, groups, rules, theme } = state;
      downloadBlob(
        new Blob([buildBackup({ inputs, groups, rules, theme }, at)], {
          type: 'application/json',
        }),
        `bulk-replace-workspace-${timestampForFileName(at)}.json`,
      );
      flash('作業データを書き出しました');
    });
  };

  const selectBackupFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // 同じファイルを選び直せるように、読み取り前に値を空へ戻す。
    event.target.value = '';
    if (!file) return;
    // 作業データは自分が書き出した UTF-8 なので、文字コードの推測は気にしない。
    const parsed = parseBackup(decodeText(await file.arrayBuffer()).text);
    if (parsed.kind === 'ok') {
      setPendingWorkspace(parsed.workspace);
      setBackupCandidate({ kind: 'ok', fileName: file.name, summary: parsed.summary });
      return;
    }
    setPendingWorkspace(null);
    setBackupCandidate({ kind: 'error', fileName: file.name, message: parsed.message });
  };

  const applyBackup = (): void => {
    const workspace = pendingWorkspace;
    if (!workspace) return;
    guard('作業データの読み込み', () => {
      dispatch({ type: 'workspace/replace', workspace });
      closeBackup();
      flash(`作業データを読み込みました（入力${workspace.inputs.length}件）`);
    });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  // 全入力の本文を JSON 化するので、打鍵のたびに走らせない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 指紋の材料は入力・グループ・ルールだけ
  const signature = useMemo(
    () => workspaceSignature(state),
    [state.inputs, state.groups, state.rules],
  );
  const stale = state.result !== null && signature !== state.lastSignature;
  const cards = state.ruleView === 'auto' ? narrow : state.ruleView === 'card';

  const tabs: TabDescriptor[] = [
    { key: 'input', label: '入力', count: String(state.inputs.length) },
    { key: 'rules', label: 'ルール', count: String(state.rules.filter((r) => r.src).length) },
    {
      key: 'output',
      label: '出力',
      count: state.result ? String(state.result.groups.length) : '—',
      badge: stale,
    },
  ];

  // ---- 入力 ----------------------------------------------------------------

  const addFiles = async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0) return;
    const { inputs, skipped, guessedShiftJis } = await readInputFiles(list);
    dispatch({ type: 'inputs/addMany', inputs });
    flash(
      `${inputs.length}件のファイルを追加しました` +
        (skipped ? ` · ${skipped}件は非対応形式のためスキップ` : '') +
        // Shift_JIS は「UTF-8 として読めなかった」だけの推測なので、
        // 黙って取り込まず、目で確かめてもらう。
        (guessedShiftJis.length > 0
          ? ` · ${guessedShiftJis.length}件は Shift_JIS として読み込みました（文字化けが無いか確認してください）`
          : ''),
    );
  };

  const openEditor = (id: string, caret: number, scrollRatio: number): void => {
    dispatch({ type: 'editor/open', id, caret, scrollRatio });
  };

  const closeEditor = (): void => {
    const id = state.editingId;
    dispatch({ type: 'editor/close' });
    // スクロールロック解除のあとに、編集していたカードまで戻し、起点へフォーカスを返す。
    // <dialog> 自身も閉じる際にフォーカスを戻すが、挙動がブラウザ依存なので明示しておく。
    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-input-id="${id}"]`);
      if (!card) return;
      const top = card.getBoundingClientRect().top + window.scrollY - SCROLL_BACK_OFFSET;
      window.scrollTo({ top: Math.max(0, top) });
      card.querySelector<HTMLTextAreaElement>('.input-card__preview')?.focus({
        preventScroll: true,
      });
    });
  };

  // ---- 変換・書き出し ------------------------------------------------------

  /**
   * イベントハンドラ内の例外を受け止める。
   *
   * React のエラー境界が拾うのは描画中とライフサイクル中の例外だけで、onClick から
   * 同期で呼ぶ変換や書き出しで落ちても復旧画面は出ず、画面が固まったままになる。
   * ここで受けてトーストに倒す。
   */
  const guard = (label: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      console.error(`${label}に失敗しました`, error);
      flash(`${label}に失敗しました`);
    }
  };

  /**
   * 確認を出して、通ったときだけ実行する。
   *
   * 確認の結果を待つあいだに await を挟むので、実行側の例外は `guard` で受け直す
   * （React のエラー境界も、非同期の続きでは拾えない）。
   */
  const confirmThen = async (request: ConfirmRequest, action: () => void): Promise<void> => {
    if (await confirm.ask(request)) guard('操作', action);
  };

  const run = (): void => {
    if (state.inputs.length === 0) {
      flash('入力テキストがありません');
      dispatch({ type: 'tab/set', tab: 'input' });
      return;
    }
    // 正規表現が壊れている行は変換時に黙って捨てられる。エラー表示を見落としたまま
    // 「そのルールだけ効いていない完成物」を保存できてしまうので、ここで止める。
    const errors = collectRuleErrors(state.rules);
    if (errors.size > 0) {
      flash(`正規表現エラーが${errors.size}件あります。直してから変換してください`);
      dispatch({ type: 'tab/set', tab: 'rules' });
      return;
    }
    guard('変換', () => {
      const result = runConversion(state);
      dispatch({ type: 'result/set', result, signature });
      const unmatched = findUnmatchedRules(state.rules, state.groups, result);
      // 0件そのものは異常ではないので止めない。打ち間違いや表記違いに気づけるようにだけする。
      if (unmatched.length > 0) {
        flash(`変換しました（1件も置換されなかったルールが${unmatched.length}件あります）`);
      }
    });
  };

  const downloadZip = (): void => {
    const result = state.result;
    if (!result) return;
    guard('ZIPの保存', () => {
      const entries = result.groups.flatMap((group) =>
        group.files.map((file) => ({ name: `${group.dir}/${file.title}`, text: file.text })),
      );
      downloadBlob(
        createZip(entries, result.at),
        `converted-${timestampForFileName(result.at)}.zip`,
      );
      flash(`${entries.length}ファイルをZIPで保存しました`);
    });
  };

  const downloadFile = (file: ResultFile): void => {
    guard('ファイルの保存', () =>
      downloadBlob(
        new Blob([file.text], { type: 'text/plain;charset=utf-8' }),
        // resolveFileNames で区切りは潰してあるので、ここで basename を取る必要はない。
        file.title,
      ),
    );
  };

  const copyFile = async (file: ResultFile): Promise<void> => {
    const copied = await copyText(file.text);
    flash(copied ? 'コピーしました' : 'コピーできませんでした');
  };

  const exportRules = (delimiter: Delimiter): void => {
    guard('ルール表の書き出し', () => {
      const text = rulesToDelimited(state.groups, state.rules, delimiter);
      const csv = delimiter === ',';
      downloadBlob(
        new Blob([withBom(text)], {
          type: csv ? 'text/csv' : 'text/tab-separated-values',
        }),
        csv ? 'rules.csv' : 'rules.tsv',
      );
    });
  };

  // ---- 表インポート --------------------------------------------------------

  const parsedImport = useMemo(
    () => (state.importOpen ? parseTable(state.importText) : { rows: [], kind: null }),
    [state.importOpen, state.importText],
  );

  const applyImport = async (): Promise<void> => {
    const built = buildRulesFromTable({
      rows: parsedImport.rows,
      mode: state.importMode,
      currentGroups: state.groups,
      currentRules: state.rules,
    });
    if (!built) {
      flash('見出し行＋1行以上の表が必要です');
      return;
    }

    // 列数が食い違う表は、区切りが壊れている可能性が高い。足りないセルは空として
    // 扱われるので「読み込めた」ように見えてしまう。確定させる前に見せる。
    const ragged = findRaggedRows(parsedImport.rows);

    // 置き換えは、いま画面にあるルールとグループをまとめて捨てる。
    // 中身があるときだけ、何が失われるかを見せて確認する。
    const losing = state.rules.filter((rule) => rule.src !== '').length;
    const replacing = state.importMode === 'replace' && losing > 0;

    if (replacing || ragged.length > 0) {
      const details = [
        ...(ragged.length > 0 ? [`列数が合わない行 ${ragged.length}行`] : []),
        ...(replacing
          ? [`失われるルール ${losing}行`, `失われるグループ ${state.groups.length}件`]
          : []),
      ];
      const ok = await confirm.ask({
        title: replacing ? '現在のルール表を置き換える' : '列数が合わない行があります',
        message: replacing
          ? '取り消せません。書き出していないルールは失われます。'
          : '区切りが壊れていると、一部だけ違うルールとして読み込まれます。',
        details,
        confirmLabel: replacing ? '置き換える' : 'このまま読み込む',
      });
      if (!ok) return;
    }

    guard('表の読み込み', () => {
      dispatch({ type: 'import/apply', groups: built.groups, rules: built.rules });
      flash(`${built.imported}行を読み込みました`);
    });
  };

  // ---- 子コンポーネントへ渡すハンドラ --------------------------------------

  // 受け取り側は memo 化していないので、参照を固定しても再描画は減らない。
  // 素直に毎回作る（依存配列の取りこぼしで古い値を掴む事故の方が高くつく）。
  const ruleHandlers: RuleHandlers = {
    onChangeSrc: (id, src) => dispatch({ type: 'rules/update', id, patch: { src } }),
    onChangeValue: (ruleId, groupId, value) =>
      dispatch({ type: 'rules/setValue', ruleId, groupId, value }),
    onToggleRegex: (rule) =>
      dispatch({ type: 'rules/update', id: rule.id, patch: { regex: !rule.regex } }),
    onToggleCase: (rule) =>
      dispatch({ type: 'rules/update', id: rule.id, patch: { cs: !rule.cs } }),
    onToggleOrder: (rule) => {
      const order: RuleOrder = rule.order === 'seq' ? 'sim' : 'seq';
      dispatch({ type: 'rules/update', id: rule.id, patch: { order } });
    },
    onMove: (index, delta) => dispatch({ type: 'rules/move', index, delta }),
    onRemove: (id) => dispatch({ type: 'rules/remove', id }),
    onEditCell: (ruleId, groupId) =>
      dispatch({ type: 'cellEdit/open', target: { ruleId, groupId } }),
  };

  const groupHandlers: GroupHandlers = {
    onRename: (id, name) => dispatch({ type: 'groups/rename', id, name }),
    onRemove: (id) => dispatch({ type: 'groups/remove', id }),
    onAdd: () =>
      dispatch({ type: 'groups/add', group: createGroup(`グループ${state.groups.length + 1}`) }),
  };

  // ---- ドラッグ＆ドロップ --------------------------------------------------

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (hasFiles(event)) event.preventDefault();
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  // ウィンドウの外でドロップされると dragleave が対で飛ばず、案内が出たままになる。
  useEffect(() => {
    const reset = (): void => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, []);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  const onFilesSelected = (event: ChangeEvent<HTMLInputElement>): void => {
    void addFiles(event.target.files);
    event.target.value = '';
  };

  const onTableFileSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const { text, encoding } = decodeText(await file.arrayBuffer());
    dispatch({ type: 'import/setText', text });
    if (encoding === 'shift_jis') {
      flash(`${file.name} を Shift_JIS として読み込みました。文字化けが無いか確かめてください`);
    }
  };

  /**
   * 編集中のセル。対象が消えている（行やグループを削除した）場合は開かない。
   */
  const cellEdit = ((): {
    label: string;
    value: string;
    onChange: (value: string) => void;
  } | null => {
    const target = state.cellEdit;
    if (!target) return null;
    const index = state.rules.findIndex((rule) => rule.id === target.ruleId);
    const rule = state.rules[index];
    if (!rule) return null;

    if (target.groupId === null) {
      return {
        label: srcCellLabel(index),
        value: rule.src,
        onChange: (src) => dispatch({ type: 'rules/update', id: rule.id, patch: { src } }),
      };
    }
    const group = state.groups.find((candidate) => candidate.id === target.groupId);
    if (!group) return null;
    return {
      label: valueCellLabel(index, group.name),
      value: rule.values[group.id] ?? '',
      onChange: (value) =>
        dispatch({ type: 'rules/setValue', ruleId: rule.id, groupId: group.id, value }),
    };
  })();

  const editingIndex = state.inputs.findIndex((input) => input.id === state.editingId);
  const editing = editingIndex >= 0 ? state.inputs[editingIndex] : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ページ全体をファイルのドロップ先にしている
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="app__topbar">
        <AppHeader
          theme={state.theme}
          onToggleTheme={() => dispatch({ type: 'theme/toggle' })}
          onOpenBackup={openBackup}
          onRun={run}
        />
        <TabBar
          tabs={tabs}
          current={state.tab}
          onSelect={(tab) => dispatch({ type: 'tab/set', tab })}
        />
      </div>

      <main className="app__main">
        {state.tab === 'input' ? (
          <InputPanel
            inputs={state.inputs}
            fileInputRef={fileInputRef}
            onPickFiles={() => fileInputRef.current?.click()}
            onFilesSelected={onFilesSelected}
            onAddInput={() => {
              const input = createInput(`text-${state.inputs.length + 1}.txt`);
              dispatch({ type: 'inputs/add', input });
              openEditor(input.id, 0, 0);
            }}
            onClearInputs={() => {
              void confirmThen(
                {
                  title: '入力テキストをすべて削除する',
                  message: '取り消せません。書き出していない本文は失われます。',
                  details: [`入力 ${state.inputs.length}件`],
                  confirmLabel: 'すべて削除する',
                },
                () => dispatch({ type: 'inputs/clear' }),
              );
            }}
            onRenameInput={(id, title) => dispatch({ type: 'inputs/update', id, patch: { title } })}
            onRemoveInput={(id) => dispatch({ type: 'inputs/remove', id })}
            onOpenEditor={openEditor}
          />
        ) : null}

        {state.tab === 'rules' ? (
          <RulesPanel
            groups={state.groups}
            rules={state.rules}
            result={state.result}
            cards={cards}
            onSetView={(view) => dispatch({ type: 'ruleView/set', view })}
            onAddRule={() => dispatch({ type: 'rules/add', rule: createEmptyRule() })}
            ruleHandlers={ruleHandlers}
            groupHandlers={groupHandlers}
            onOpenImport={() => dispatch({ type: 'import/open' })}
            onExportCsv={() => exportRules(',')}
            onExportTsv={() => exportRules('\t')}
          />
        ) : null}

        {state.tab === 'output' ? (
          <OutputPanel
            result={state.result}
            outGroupId={state.outGroupId}
            fileViews={state.fileViews}
            stale={stale}
            onRun={run}
            onSelectGroup={(id) => dispatch({ type: 'output/selectGroup', id })}
            onSetFileView={(key, view) => dispatch({ type: 'output/setFileView', key, view })}
            onDownloadZip={downloadZip}
            onCopyFile={(file) => void copyFile(file)}
            onDownloadFile={downloadFile}
          />
        ) : null}
      </main>

      {dragging ? <DropOverlay /> : null}

      {editing ? (
        <EditorOverlay
          input={editing}
          index={editingIndex}
          total={state.inputs.length}
          initialCaret={state.editorCaret.caret}
          initialScrollRatio={state.editorCaret.scrollRatio}
          onChangeTitle={(title) =>
            dispatch({ type: 'inputs/update', id: editing.id, patch: { title } })
          }
          onChangeText={(text) =>
            dispatch({ type: 'inputs/update', id: editing.id, patch: { text } })
          }
          onPrev={() => {
            const prev = state.inputs[editingIndex - 1];
            if (prev) openEditor(prev.id, 0, 0);
          }}
          onNext={() => {
            const next = state.inputs[editingIndex + 1];
            if (next) openEditor(next.id, 0, 0);
          }}
          onClose={closeEditor}
        />
      ) : null}

      {state.importOpen ? (
        <ImportDialog
          text={state.importText}
          mode={state.importMode}
          parsed={parsedImport}
          fileInputRef={tableFileInputRef}
          onChangeText={(text) => dispatch({ type: 'import/setText', text })}
          onChangeMode={(mode) => dispatch({ type: 'import/setMode', mode })}
          onPickFile={() => tableFileInputRef.current?.click()}
          onFileSelected={(event) => void onTableFileSelected(event)}
          onClose={() => dispatch({ type: 'import/close' })}
          onApply={() => void applyImport()}
        />
      ) : null}

      {saveFailed ? (
        <div className="save-error" role="alert">
          <span>
            ブラウザに保存できませんでした（容量がいっぱいの可能性があります）。
            このまま編集を続けると、閉じたときに失われます。
          </span>
          <button type="button" className="btn btn--small" onClick={openBackup}>
            作業データを書き出す
          </button>
        </div>
      ) : null}

      {backupOpen ? (
        <BackupDialog
          candidate={backupCandidate}
          fileInputRef={backupFileInputRef}
          onExport={exportBackup}
          onPickFile={() => backupFileInputRef.current?.click()}
          onFileSelected={(event) => void selectBackupFile(event)}
          onApply={applyBackup}
          onClose={closeBackup}
        />
      ) : null}

      {cellEdit ? (
        <CellEditor
          label={cellEdit.label}
          value={cellEdit.value}
          onChange={cellEdit.onChange}
          onClose={() => dispatch({ type: 'cellEdit/close' })}
        />
      ) : null}

      {confirm.pending ? (
        <ConfirmDialog
          request={confirm.pending}
          onConfirm={confirm.accept}
          onCancel={confirm.reject}
        />
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
