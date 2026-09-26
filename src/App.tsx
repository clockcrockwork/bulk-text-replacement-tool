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
import { DropOverlay } from './components/DropOverlay';
import { EditorOverlay } from './components/EditorOverlay';
import { ImportDialog } from './components/ImportDialog';
import { InputPanel } from './components/InputPanel';
import { OutputPanel } from './components/OutputPanel';
import { RulesPanel } from './components/RulesPanel';
import type { GroupHandlers, RuleHandlers } from './components/ruleTypes';
import { TabBar, type TabDescriptor } from './components/TabBar';
import { Toast } from './components/Toast';
import { useNarrowScreen } from './hooks/useNarrowScreen';
import { usePersistedWorkspace } from './hooks/usePersistedWorkspace';
import { useToast } from './hooks/useToast';
import { copyText, downloadBlob, timestampForFileName } from './lib/browser';
import { readInputFiles } from './lib/inputFiles';
import { runConversion } from './lib/replace';
import { buildRulesFromTable, type Delimiter, parseTable, rulesToDelimited } from './lib/table';
import { createZip } from './lib/zip';
import {
  createEmptyRule,
  createGroup,
  createInput,
  initWorkspace,
  workspaceReducer,
  workspaceSignature,
} from './state/workspace';
import type { ResultFile, RuleOrder } from './types';

/** エディタを閉じたとき、元のカードがヘッダーに隠れないよう空ける余白。 */
const SCROLL_BACK_OFFSET = 130;

/** ドラッグ中の DataTransfer にファイルが含まれるか。テキスト選択のドラッグを無視する。 */
function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer.types ?? [])].includes('Files');
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initWorkspace);
  const { message: toast, flash } = useToast();
  const narrow = useNarrowScreen();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tableFileInputRef = useRef<HTMLInputElement>(null);
  /** エディタを開くときに引き継ぐキャレット位置。 */
  const caretRef = useRef({ caret: 0, ratio: 0 });
  /** dragenter / dragleave が子要素でも飛ぶので、深さを数えて判定する。 */
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  usePersistedWorkspace(state);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  const signature = workspaceSignature(state);
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
    const { inputs, skipped } = await readInputFiles(list);
    dispatch({ type: 'inputs/addMany', inputs });
    flash(
      `${inputs.length}件のファイルを追加しました` +
        (skipped ? ` · ${skipped}件は非対応形式のためスキップ` : ''),
    );
  };

  const openEditor = (id: string, caret: number, ratio: number): void => {
    caretRef.current = { caret, ratio };
    dispatch({ type: 'editor/open', id });
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

  const run = (): void => {
    if (state.inputs.length === 0) {
      flash('入力テキストがありません');
      dispatch({ type: 'tab/set', tab: 'input' });
      return;
    }
    const result = runConversion(state);
    dispatch({ type: 'result/set', result, signature });
  };

  const downloadZip = (): void => {
    const result = state.result;
    if (!result) return;
    const entries = result.groups.flatMap((group) =>
      group.files.map((file) => ({ name: `${group.dir}/${file.title}`, text: file.text })),
    );
    downloadBlob(createZip(entries, result.at), `converted-${timestampForFileName(result.at)}.zip`);
    flash(`${entries.length}ファイルをZIPで保存しました`);
  };

  const downloadFile = (file: ResultFile): void => {
    downloadBlob(
      new Blob([file.text], { type: 'text/plain;charset=utf-8' }),
      file.title.split('/').pop() ?? file.title,
    );
  };

  const copyFile = async (file: ResultFile): Promise<void> => {
    await copyText(file.text);
    flash('コピーしました');
  };

  const exportRules = (delimiter: Delimiter): void => {
    const text = rulesToDelimited(state.groups, state.rules, delimiter);
    const csv = delimiter === ',';
    downloadBlob(
      // Excel が UTF-8 と判定できるよう BOM を付ける。
      new Blob([`﻿${text}`], {
        type: csv ? 'text/csv' : 'text/tab-separated-values',
      }),
      csv ? 'rules.csv' : 'rules.tsv',
    );
  };

  // ---- 表インポート --------------------------------------------------------

  const parsedImport = useMemo(
    () => (state.importOpen ? parseTable(state.importText) : { rows: [], kind: null }),
    [state.importOpen, state.importText],
  );

  const applyImport = (): void => {
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
    dispatch({ type: 'import/apply', groups: built.groups, rules: built.rules });
    flash(`${built.imported}行を読み込みました`);
  };

  // ---- 子コンポーネントへ渡すハンドラ --------------------------------------

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
    dispatch({ type: 'import/setText', text: (await file.text()).replace(/^﻿/, '') });
  };

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
              if (confirm('入力テキストをすべて削除しますか？')) dispatch({ type: 'inputs/clear' });
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
          initialCaret={caretRef.current.caret}
          initialScrollRatio={caretRef.current.ratio}
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
          onApply={applyImport}
        />
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
