import { uniqueName } from '../lib/fileName';
import { createGroupId, createId } from '../lib/id';
import { loadWorkspace, preferredTheme } from '../lib/storage';
import type {
  ConversionResult,
  Group,
  ImportMode,
  InputText,
  PersistedWorkspace,
  Rule,
  RuleView,
  Tab,
  Theme,
} from '../types';

/** 同名のグループが残らないよう、後から出てきた方に連番を振る。 */
function dedupeGroupNames(groups: readonly Group[]): Group[] {
  const used = new Set<string>();
  return groups.map((group) => {
    const name = uniqueName(group.name, used);
    used.add(name);
    return { ...group, name };
  });
}

/** 複数行セルの編集対象。`groupId` が null なら置換元の列。 */
export interface CellEditTarget {
  ruleId: string;
  groupId: string | null;
}

/** 出力ペインの本文表示モード。 */
export type FileView = 'highlight' | 'plain';

export interface WorkspaceState {
  // ---- 永続化する状態 ----
  inputs: InputText[];
  groups: Group[];
  rules: Rule[];
  theme: Theme;

  // ---- 画面の状態（永続化しない） ----
  tab: Tab;
  ruleView: RuleView;
  /** 編集中の入力テキスト ID。null なら全画面エディタは閉じている。 */
  editingId: string | null;
  /**
   * エディタを開くときにプレビューから引き継ぐ表示位置。
   * ref をレンダー中に読むのは React の原則に反するので、状態として持つ。
   */
  editorCaret: { caret: number; scrollRatio: number };
  result: ConversionResult | null;
  /** `result` を作ったときの入力の指紋。現在値と違えば「未反映の変更」バッジを出す。 */
  lastSignature: string | null;
  outGroupId: string | null;
  /** `${groupId}:${fileIndex}` → 表示モード。 */
  fileViews: Record<string, FileView>;
  /**
   * 複数行セルの編集対象。`groupId` が null なら置換元の列。
   *
   * 改行を含む値は1行の `<input>` に載せられない（載せると編集した瞬間に改行が消える）。
   * 表の一覧性は崩さず、編集だけ別の場所で行う。
   */
  cellEdit: CellEditTarget | null;
  importOpen: boolean;
  importText: string;
  importMode: ImportMode;
}

export type WorkspaceAction =
  | { type: 'theme/toggle' }
  | { type: 'tab/set'; tab: Tab }
  | { type: 'ruleView/set'; view: RuleView }
  | { type: 'inputs/add'; input: InputText }
  | { type: 'inputs/addMany'; inputs: InputText[] }
  | { type: 'inputs/update'; id: string; patch: Partial<Omit<InputText, 'id'>> }
  | { type: 'inputs/remove'; id: string }
  | { type: 'inputs/clear' }
  | { type: 'workspace/replace'; workspace: PersistedWorkspace }
  | { type: 'groups/add'; group: Group }
  | { type: 'groups/rename'; id: string; name: string }
  | { type: 'groups/remove'; id: string }
  | { type: 'rules/add'; rule: Rule }
  | { type: 'rules/update'; id: string; patch: Partial<Omit<Rule, 'id' | 'values'>> }
  | { type: 'rules/setValue'; ruleId: string; groupId: string; value: string }
  | { type: 'rules/move'; index: number; delta: number }
  | { type: 'rules/remove'; id: string }
  | { type: 'editor/open'; id: string; caret: number; scrollRatio: number }
  | { type: 'editor/close' }
  | { type: 'import/open' }
  | { type: 'import/close' }
  | { type: 'import/setText'; text: string }
  | { type: 'import/setMode'; mode: ImportMode }
  | { type: 'import/apply'; groups: Group[]; rules: Rule[] }
  | { type: 'result/set'; result: ConversionResult; signature: string }
  | { type: 'output/selectGroup'; id: string }
  | { type: 'output/setFileView'; key: string; view: FileView }
  | { type: 'cellEdit/open'; target: CellEditTarget }
  | { type: 'cellEdit/close' };

/** 置換元が空の新規行。表の末尾に置いて入力待ちにする。 */
export function createEmptyRule(): Rule {
  return { id: createId(), src: '', regex: false, cs: true, order: 'sim', values: {} };
}

export function createGroup(name: string): Group {
  return { id: createGroupId(), name };
}

export function createInput(title: string, text = ''): InputText {
  return { id: createId(), title, text };
}

/**
 * 初回訪問時に置くサンプル。使い方（グループ列・置換ルール）が一目で分かる状態にしておく。
 */
function createDefaultState(): Pick<WorkspaceState, 'inputs' | 'groups' | 'rules' | 'theme'> {
  const groupA = createGroup('A用');
  const groupB = createGroup('B用');
  return {
    inputs: [
      createInput(
        'chapter1.md',
        '# 第一章\n\nアリスは川辺でビルと並んで座っていた。\nビルが「アリス、あれを見て」と言うと、アリスは顔を上げた。\n',
      ),
    ],
    groups: [groupA, groupB],
    rules: [
      {
        id: createId(),
        src: 'アリス',
        regex: false,
        cs: true,
        order: 'sim',
        values: { [groupA.id]: 'あーちゃん', [groupB.id]: 'びーちゃん' },
      },
      {
        id: createId(),
        src: 'ビル',
        regex: false,
        cs: true,
        order: 'sim',
        values: { [groupA.id]: 'びる', [groupB.id]: 'れいちゃん' },
      },
      createEmptyRule(),
    ],
    theme: preferredTheme(),
  };
}

/** localStorage があればそれを、無ければサンプルを初期状態にする。 */
export function initWorkspace(): WorkspaceState {
  const saved = loadWorkspace();
  const base = saved ?? createDefaultState();
  return {
    ...base,
    tab: 'input',
    ruleView: 'auto',
    editingId: null,
    editorCaret: { caret: 0, scrollRatio: 0 },
    result: null,
    lastSignature: null,
    outGroupId: null,
    fileViews: {},
    cellEdit: null,
    importOpen: false,
    importText: '',
    // 既定は非破壊側。置き換えは取り消せないので、選ぶのはユーザーの明示操作にする。
    importMode: 'append',
  };
}

/** 変換結果が現在の入力と一致しているか判定するための指紋。 */
export function workspaceSignature(state: WorkspaceState): string {
  return JSON.stringify([
    state.inputs.map((input) => [input.title, input.text]),
    state.groups,
    state.rules,
  ]);
}

/** 配列の中から id 一致の要素だけを差し替える。 */
function patchById<T extends { id: string }>(
  items: readonly T[],
  id: string,
  patch: Partial<Omit<T, 'id'>>,
): T[] {
  return items.map((item) => (item.id === id ? ({ ...item, ...patch } as T) : item));
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'theme/toggle':
      return { ...state, theme: state.theme === 'dark' ? 'light' : 'dark' };

    case 'tab/set':
      return { ...state, tab: action.tab };

    case 'ruleView/set':
      return { ...state, ruleView: action.view };

    case 'inputs/add':
      return { ...state, inputs: [...state.inputs, action.input] };

    case 'inputs/addMany': {
      if (action.inputs.length === 0) return state;
      // 手つかずの空欄が1つだけ残っている状態なら、それを取り込んだファイルで置き換える。
      const first = state.inputs[0];
      const base = state.inputs.length === 1 && first && !first.text.trim() ? [] : state.inputs;
      return { ...state, inputs: [...base, ...action.inputs], tab: 'input' };
    }

    case 'inputs/update':
      return { ...state, inputs: patchById(state.inputs, action.id, action.patch) };

    case 'inputs/remove':
      return {
        ...state,
        inputs: state.inputs.filter((input) => input.id !== action.id),
        editingId: state.editingId === action.id ? null : state.editingId,
      };

    case 'inputs/clear':
      return { ...state, inputs: [], editingId: null };

    case 'workspace/replace':
      // 作業データの読み込み。古い変換結果とエディタの状態は、新しい入力に
      // 対応しないので一緒に捨てる（残すと別の原稿の結果を持ち出せてしまう）。
      return {
        ...state,
        ...action.workspace,
        groups: dedupeGroupNames(action.workspace.groups),
        editingId: null,
        result: null,
        lastSignature: null,
        outGroupId: null,
        fileViews: {},
        cellEdit: null,
      };

    case 'groups/add': {
      // グループ名は出力先（タブ名・ZIP のディレクトリ名）の識別子になるので、
      // 見た目が同じものを作らない。
      const used = new Set(state.groups.map((group) => group.name));
      const name = uniqueName(action.group.name, used);
      return { ...state, groups: [...state.groups, { ...action.group, name }] };
    }

    case 'groups/rename':
      return { ...state, groups: patchById(state.groups, action.id, { name: action.name }) };

    case 'groups/remove': {
      // 列が0本になると置換先を入れる場所が無くなるので、最後の1本は消させない。
      if (state.groups.length <= 1) return state;
      return {
        ...state,
        groups: state.groups.filter((group) => group.id !== action.id),
        // 消したグループの置換先を rule.values に残さない。残すと localStorage に
        // 積もり続け、workspaceSignature（未反映バッジの判定）にも混ざる。
        rules: state.rules.map((rule) => {
          if (!(action.id in rule.values)) return rule;
          const values = { ...rule.values };
          delete values[action.id];
          return { ...rule, values };
        }),
      };
    }

    case 'rules/add':
      return { ...state, rules: [...state.rules, action.rule] };

    case 'rules/update':
      return { ...state, rules: patchById(state.rules, action.id, action.patch) };

    case 'rules/setValue':
      return {
        ...state,
        rules: state.rules.map((rule) =>
          rule.id === action.ruleId
            ? { ...rule, values: { ...rule.values, [action.groupId]: action.value } }
            : rule,
        ),
      };

    case 'rules/move': {
      const to = action.index + action.delta;
      if (to < 0 || to >= state.rules.length) return state;
      const rules = [...state.rules];
      const from = rules[action.index];
      const target = rules[to];
      if (!from || !target) return state;
      rules[action.index] = target;
      rules[to] = from;
      return { ...state, rules };
    }

    case 'rules/remove':
      return { ...state, rules: state.rules.filter((rule) => rule.id !== action.id) };

    case 'editor/open':
      return {
        ...state,
        editingId: action.id,
        editorCaret: { caret: action.caret, scrollRatio: action.scrollRatio },
      };

    case 'editor/close':
      return { ...state, editingId: null };

    case 'import/open':
      return { ...state, importOpen: true };

    case 'import/close':
      return { ...state, importOpen: false };

    case 'import/setText':
      return { ...state, importText: action.text };

    case 'import/setMode':
      return { ...state, importMode: action.mode };

    case 'import/apply':
      return {
        ...state,
        groups: action.groups,
        rules: action.rules,
        importOpen: false,
        importText: '',
      };

    case 'result/set': {
      const stillExists = action.result.groups.some((group) => group.id === state.outGroupId);
      return {
        ...state,
        result: action.result,
        lastSignature: action.signature,
        tab: 'output',
        outGroupId: stillExists ? state.outGroupId : (action.result.groups[0]?.id ?? null),
      };
    }

    case 'output/selectGroup':
      return { ...state, outGroupId: action.id };

    case 'output/setFileView':
      return { ...state, fileViews: { ...state.fileViews, [action.key]: action.view } };

    case 'cellEdit/open':
      return { ...state, cellEdit: action.target };

    case 'cellEdit/close':
      return { ...state, cellEdit: null };

    default: {
      // すべての action を処理し終えたことを型で保証する。
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
