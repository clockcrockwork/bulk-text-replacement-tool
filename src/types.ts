/** アプリ全体で共有するドメイン型。UI からもロジックからも参照する。 */

/** 変換対象の入力テキスト1件。 */
export interface InputText {
  id: string;
  /** 出力ファイル名として使う。空ならフォールバック名を割り当てる。 */
  title: string;
  text: string;
  /**
   * どこから取り込んだか。手入力・ローカルファイルには無い。
   *
   * タイトルは利用者が書き換える出力名なので、取り込み元の同定には使えない。
   * 同じファイルを取り込み直したかどうかは、ここで判断する。
   */
  source?: GitHubInputSource;
}

/**
 * GitHub から取り込んだ入力の出自。
 *
 * 同一性（同じ取り込み元か）は `repositoryId + ref + path` で決める。
 * `commitSha` / `blobSha` は「どの時点の内容か」の記録で、同一性には含めない
 * （含めると、ブランチが進んだあとの取り込み直しが別物扱いになる）。
 */
export interface GitHubInputSource {
  kind: 'github';
  /** リポジトリ名の変更や移管で owner/repo が変わっても同じものと分かるよう、数値 ID を持つ。 */
  repositoryId: number;
  owner: string;
  repo: string;
  /** ブランチ名（`refs/heads/` は付けない）。 */
  ref: string;
  /** 取り込んだ時点で固定していたコミット。 */
  commitSha: string;
  /** リポジトリ内のパス（先頭の `/` は付けない）。 */
  path: string;
  blobSha: string;
}

/**
 * 出力グループ（＝置換表の1列・ZIP内の1ディレクトリ）。
 * 「A用」「B用」のように、同じ入力から別々の置換結果を作るための単位。
 */
export interface Group {
  id: string;
  name: string;
}

/**
 * ルールの適用順。
 * - `sim`（同時）: 連続する `sim` 行をまとめて1パスで適用する。長い一致を優先し、置換結果は再走査しない（連鎖しない）。
 * - `seq`（順次）: それまでの置換結果に対して、その行だけを単独で適用する。
 */
export type RuleOrder = 'sim' | 'seq';

/** 置換ルール1行。グループごとの置換先を `values` に持つ。 */
export interface Rule {
  id: string;
  /** 置換元。`regex` が true なら正規表現ソースとして解釈する。 */
  src: string;
  regex: boolean;
  /** 大文字・小文字を区別するか。 */
  cs: boolean;
  order: RuleOrder;
  /** グループ ID → 置換先文字列。空文字・未定義はそのグループでは置換しない。 */
  values: Record<string, string>;
}

/** 置換結果のテキスト断片。`hit` が true の範囲は置換で生成された部分。 */
export interface Segment {
  text: string;
  hit: boolean;
}

/** 1入力 × 1グループの変換結果。 */
export interface ResultFile {
  /** 重複解決とサニタイズ済みの出力ファイル名。 */
  title: string;
  text: string;
  /** ハイライト表示用の断片列。連結すると `text` と一致する。 */
  segments: Segment[];
  /** このファイルでの置換件数。 */
  hits: number;
}

/** 1グループ分の変換結果。 */
export interface ResultGroup {
  id: string;
  name: string;
  /** ZIP 内のディレクトリ名（サニタイズ・重複解決済み）。 */
  dir: string;
  files: ResultFile[];
  /** グループ全体の置換件数。 */
  hits: number;
}

/** 変換1回分の結果。 */
export interface ConversionResult {
  at: Date;
  groups: ResultGroup[];
  /** グループ ID → ルール ID → 置換件数。ルール表のヒット数表示に使う。 */
  hitsByGroupRule: Record<string, Record<string, number>>;
}

/** localStorage に永続化する範囲。 */
export interface PersistedWorkspace {
  inputs: InputText[];
  groups: Group[];
  rules: Rule[];
  theme: Theme;
  /**
   * 中身が初回のサンプルのままか。
   *
   * サンプルは使い方を見せるために置いてあるが、そのまま実原稿を足すと
   * 結果にサンプルが混ざり、サンプルのルールが実原稿に当たる。まだ手を付けて
   * いないあいだだけ true にして、実データが入ったら片付ける判断に使う。
   * 保存データに無ければ false（サンプルではない）として扱う。
   */
  isSample: boolean;
}

export type Theme = 'light' | 'dark';

/** 画面タブ。 */
export type Tab = 'input' | 'rules' | 'output';

/** ルール表の表示形式。`auto` は画面幅で表／カードを切り替える。 */
export type RuleView = 'auto' | 'table' | 'card';

/** 表インポート時に既存ルールをどう扱うか。 */
export type ImportMode = 'replace' | 'append';

// ---- GitHub 取り込み ---------------------------------------------------------

/** GitHub App がアクセスを許されているリポジトリ。 */
export interface GitHubRepository {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * ブランチを選んだ時点で固定した内容のスナップショット。
 *
 * ブラウズもファイルの取得も、この `commitSha` / `treeSha` から辿る。ブランチが
 * 途中で進んでも勝手に追従しない（一覧で見たものと取り込むものが食い違わないように）。
 */
export interface GitHubSnapshot {
  repository: GitHubRepository;
  ref: string;
  commitSha: string;
  treeSha: string;
}

/**
 * ツリーの1項目がどう扱われるか。
 * - `dir`: 開ける
 * - `importable`: 取り込める
 * - それ以外: 表示はするが選べない（理由を見せる）
 */
export type GitHubEntryStatus =
  | 'dir'
  | 'importable'
  | 'unsupported'
  | 'tooLarge'
  | 'symlink'
  | 'submodule';

export interface GitHubTreeEntry {
  name: string;
  /** リポジトリのルートからのパス。 */
  path: string;
  sha: string;
  status: GitHubEntryStatus;
  /** バイト数。ディレクトリなど GitHub が返さないものは null。 */
  size: number | null;
}
