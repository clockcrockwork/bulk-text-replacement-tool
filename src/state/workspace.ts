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
  /** 中身が初回のサンプルのままか。`src/types.ts` の説明を参照。 */
  isSample: boolean;

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
  | {
      type: 'inputs/applyGitHubBatch';
      updates: Array<{ id: string; text: string; source: NonNullable<InputText['source']> }>;
      adds: InputText[];
      /** 手つかずのサンプルだったときに置く初期状態。サンプルでなければ使わない。 */
      sampleReset: SampleReset;
    }
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
  | { type: 'cellEdit/close' }
  | { type: 'sample/clear'; reset: SampleReset }
  | { type: 'workspace/restore'; workspace: PersistedWorkspace };

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

/** サンプルを片付けたあとに残す、既定のグループ1つと空のルール1行。 */
export interface SampleReset {
  group: Group;
  rule: Rule;
}

/** ID を作るので reducer の外で呼び、action に載せて渡す（reducer を純粋に保つ）。 */
export function createSampleReset(): SampleReset {
  return { group: createGroup('グループ1'), rule: createEmptyRule() };
}

/**
 * サンプルを片付けた状態。グループは空にできない（置換先を書く場所が無くなる）ので
 * 1つだけ残し、名前も既定に戻す。
 */
function clearedSample(reset: SampleReset) {
  return {
    inputs: [],
    groups: [reset.group],
    rules: [reset.rule],
    isSample: false,
    editingId: null,
    result: null,
    lastSignature: null,
    outGroupId: null,
    fileViews: {},
    cellEdit: null,
  } satisfies Partial<WorkspaceState>;
}

/**
 * 初回訪問時に置くサンプル。使い方（グループ列・置換ルール）が一目で分かる状態にしておく。
 */
function createDefaultState(): Pick<
  WorkspaceState,
  'inputs' | 'groups' | 'rules' | 'theme' | 'isSample'
> {
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
    // まだ誰も触っていないサンプル。実データが入ったら片付ける判断に使う。
    isSample: true,
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
/** 永続化する範囲だけを取り出す（localStorage に書く形）。 */
export function toPersisted(state: WorkspaceState): PersistedWorkspace {
  const { inputs, groups, rules, theme, isSample } = state;
  return { inputs, groups, rules, theme, isSample };
}

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

/**
 * 中身に手を付けたら「サンプルのまま」ではなくなる action。
 *
 * 自動で片付けてよいのは**まだ誰も触っていないサンプル**だけ。1文字でも直したら
 * ユーザーの作業なので、勝手に消さず手動の「サンプルを片付ける」に任せる。
 */
/**
 * 入力を追加したあとも残る既存の入力。手つかずの空欄が1つだけなら、取り込んだもので
 * 置き換わるので残らない。
 *
 * reducer（`inputs/addMany` / `inputs/applyGitHubBatch`）と、取り込む前の同名・同じ取り込み元の
 * 判定の両方で使う。判定だけが消える入力を含めると、置き換わる空欄との衝突を警告したり、
 * 消える入力を更新先に選ばせたりする。
 */
export function inputsKeptOnAdd(inputs: readonly InputText[]): readonly InputText[] {
  const first = inputs[0];
  return inputs.length === 1 && first && !first.text.trim() ? [] : inputs;
}

const TOUCHES_CONTENT = new Set<WorkspaceAction['type']>([
  'inputs/add',
  'inputs/addMany',
  'inputs/applyGitHubBatch',
  'inputs/update',
  'inputs/remove',
  'inputs/clear',
  'groups/add',
  'groups/rename',
  'groups/remove',
  'rules/add',
  'rules/update',
  'rules/setValue',
  'rules/move',
  'rules/remove',
  'import/apply',
]);

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const next = reduce(state, action);
  return TOUCHES_CONTENT.has(action.type) && next.isSample ? { ...next, isSample: false } : next;
}

function reduce(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
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
      return {
        ...state,
        inputs: [...inputsKeptOnAdd(state.inputs), ...action.inputs],
        tab: 'input',
      };
    }

    case 'inputs/applyGitHubBatch': {
      if (action.updates.length === 0 && action.adds.length === 0) return state;
      // 一括取り込みは、全件の取得・検証が終わったあとの1つの action でだけ反映する。
      // 手つかずのサンプルなら、入力だけでなくサンプルのルール・グループも同じ action で
      // 片付ける（途中の状態を作らない）。
      const sampleReset = state.isSample ? clearedSample(action.sampleReset) : {};
      const updates = new Map(action.updates.map((update) => [update.id, update]));
      const existing = state.isSample ? [] : state.inputs;
      // 追加するものがあれば、通常の取り込み（`inputs/addMany`）と同じく空欄1つだけの入力は
      // 置き換える。更新先に選ばれていたら消さない（画面側の判定は `inputsKeptOnAdd` で揃えて
      // いるので起きないはずだが、更新を黙って落とさない）。
      const base =
        action.adds.length > 0 && !existing.some((input) => updates.has(input.id))
          ? inputsKeptOnAdd(existing)
          : existing;
      const replaced = base.map((input) => {
        const update = updates.get(input.id);
        return update ? { ...input, text: update.text, source: update.source } : input;
      });
      return {
        ...state,
        ...sampleReset,
        inputs: [...replaced, ...action.adds],
        tab: 'input',
      };
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

    case 'sample/clear':
      return { ...state, ...clearedSample(action.reset) };

    case 'workspace/restore':
      // 取り込みの「元に戻す」で、取り込む前の内容へまるごと戻す（サンプルの片付けと、
      // GitHub の一括取り込み）。結果は戻した内容に合わないので捨てる。
      return { ...state, ...action.workspace, result: null, lastSignature: null };

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
