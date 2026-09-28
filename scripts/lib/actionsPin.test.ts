import { describe, expect, it } from 'vitest';
import { findPinProblems } from './actionsPin.js';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const UNREADABLE = 'uses: を読めない書き方（1 行の `uses: owner/repo@<SHA> # vX.Y.Z` で書く）';

/** `jobs.build.steps` の下に行を並べたワークフロー。最初の行が 4 行目に来る。 */
function steps(...lines: string[]): string {
  return ['jobs:', '  build:', '    steps:', ...lines.map((line) => `      ${line}`), ''].join(
    '\n',
  );
}

function messages(source: string): string[] {
  return findPinProblems(source).map(({ line, message }) => `${line}: ${message}`);
}

function unpinned(line: number, ref: string): string {
  return `${line}: ${ref} がコミット SHA（40 桁）で固定されていない`;
}

describe('findPinProblems', () => {
  describe('通すもの', () => {
    it('SHA と版の注記がある', () => {
      expect(messages(steps(`- uses: actions/checkout@${SHA} # v7.0.1`))).toEqual([]);
    });

    it('引用した値、# の後ろに空白が無い注記、CRLF', () => {
      const source = steps(
        `- uses: "actions/checkout@${SHA}" # v7.0.1`,
        `- uses: 'actions/checkout@${SHA}' #v7`,
        `- uses: actions/checkout@${SHA} # v7.0.1`,
      ).replaceAll('\n', '\r\n');
      expect(messages(source)).toEqual([]);
    });

    it('フロー形式でも、固定して注記があれば通す', () => {
      expect(messages(steps(`- { uses: actions/checkout@${SHA} } # v7.0.1`))).toEqual([]);
    });

    it('同じリポジトリの Action（./）は固定しなくてよい', () => {
      expect(messages(steps('- uses: ./.github/actions/setup'))).toEqual([]);
    });

    it('再利用ワークフローの呼び出し（jobs.<id>.uses）も SHA と注記があれば通す', () => {
      const source = `jobs:\n  call:\n    uses: org/repo/.github/workflows/ci.yml@${SHA} # v1\n`;
      expect(messages(source)).toEqual([]);
    });

    it('コメントの中の uses: は見ない', () => {
      const source = `# uses: actions/checkout@v7\n${steps(`- uses: actions/checkout@${SHA} # v7.0.1 `)}`;
      expect(messages(source)).toEqual([]);
    });

    it('run: の 1 行の文字列の中にある uses: は Action ではない', () => {
      // 引用しない `run: echo "uses: x"` は plain scalar に `: ` を含み、YAML として不正
      // （GitHub も読めない）。有効な書き方では値全体を引用する。
      expect(messages(steps(`- run: 'echo "uses: something@main"'`))).toEqual([]);
    });

    it('run: | とヒアドキュメントの本文にある uses: は Action ではない', () => {
      const source = steps(
        '- run: |',
        "    cat <<'EOF'",
        '    uses: this-is-just-text',
        '    "uses": actions/checkout@v7',
        '    EOF',
        '- run: >-',
        '    uses: folded-text',
      );
      expect(messages(source)).toEqual([]);
    });

    it('Action の入力（with.uses）は参照ではない', () => {
      const source = steps(`- uses: owner/action@${SHA} # v1`, '  with:', '    uses: some-value');
      expect(messages(source)).toEqual([]);
    });

    it('env.uses は参照ではない（ワークフロー・ジョブ・ステップのどこでも）', () => {
      const source = [
        'env:',
        '  uses: top',
        'jobs:',
        '  build:',
        '    env:',
        '      uses: job',
        '    steps:',
        '      - run: echo',
        '        env:',
        '          uses: step',
        '',
      ].join('\n');
      expect(messages(source)).toEqual([]);
    });

    it('composite action の inputs.uses は参照ではない', () => {
      const source = [
        'inputs:',
        '  uses:',
        '    description: Action に渡す値',
        '    default: main',
        'runs:',
        '  using: composite',
        '  steps:',
        `    - uses: actions/checkout@${SHA} # v7.0.1`,
        '',
      ].join('\n');
      expect(messages(source)).toEqual([]);
    });

    it('Action を参照しない位置の uses は見ない（jobs / runs の外、ジョブの下の別の key）', () => {
      const source = [
        'on: push',
        'uses: not-an-action',
        'jobs:',
        '  build:',
        '    strategy:',
        '      matrix:',
        '        uses: [a, b]',
        '    steps:',
        '      - run: echo',
        '',
      ].join('\n');
      expect(messages(source)).toEqual([]);
    });

    it('steps が空・ジョブが mapping でない・トップが mapping でない', () => {
      expect(messages('jobs:\n  build:\n    steps:\n')).toEqual([]);
      expect(messages('jobs:\n  build: ~\n')).toEqual([]);
      expect(messages('- just\n- a list\n')).toEqual([]);
    });

    it('空のファイルとコメントだけのファイル', () => {
      expect(messages('')).toEqual([]);
      expect(messages('# nothing here\n')).toEqual([]);
    });
  });

  describe('落とすもの', () => {
    it('タグ・ブランチの参照', () => {
      expect(messages(steps('- uses: actions/checkout@v7'))).toEqual([
        unpinned(4, 'actions/checkout@v7'),
      ]);
      expect(messages(steps('- uses: actions/checkout@main # v7'))).toEqual([
        unpinned(4, 'actions/checkout@main'),
      ]);
    });

    it('SHA が短い・大文字', () => {
      expect(messages(steps('- uses: actions/checkout@3d3c42e # v7.0.1'))).toHaveLength(1);
      expect(
        messages(steps(`- uses: actions/checkout@${SHA.toUpperCase()} # v7.0.1`)),
      ).toHaveLength(1);
    });

    it('SHA の後ろに版の注記が無い・崩れている', () => {
      const missing = `actions/checkout@${SHA} の後ろに版の注記（例: # v7.0.1）が無い`;
      expect(messages(steps(`- uses: actions/checkout@${SHA}`))).toEqual([`4: ${missing}`]);
      expect(messages(steps(`- uses: actions/checkout@${SHA} # v7.0.1 (security)`))).toEqual([
        `4: ${missing}`,
      ]);
      // 注記が次の行にあっても、Dependabot は同じ行の注記しか書き換えない。
      expect(messages(steps(`- uses: actions/checkout@${SHA}`, '  # v7.0.1'))).toEqual([
        `4: ${missing}`,
      ]);
    });

    it('再利用ワークフローの呼び出しの未固定', () => {
      const source = 'jobs:\n  call:\n    uses: org/repo/.github/workflows/ci.yml@main\n';
      expect(messages(source)).toEqual([unpinned(3, 'org/repo/.github/workflows/ci.yml@main')]);
    });

    it('フロー形式の未固定', () => {
      expect(messages(steps('- { uses: actions/checkout@v7 }'))).toEqual([
        unpinned(4, 'actions/checkout@v7'),
      ]);
      expect(
        messages('jobs: { build: { steps: [{ name: x, uses: actions/checkout@v7 }] } }\n'),
      ).toHaveLength(1);
    });

    it('引用したキー（"uses" / \'uses\'）の未固定', () => {
      const source = steps('- "uses": actions/checkout@v7', "- 'uses': actions/setup-node@v7");
      expect(messages(source)).toEqual([
        unpinned(4, 'actions/checkout@v7'),
        unpinned(5, 'actions/setup-node@v7'),
      ]);
      // 構造側の key（jobs / steps）を引用しても位置は同じ。
      expect(messages(`"jobs":\n  build:\n    'steps':\n      - uses: a/b@v1\n`)).toEqual([
        unpinned(4, 'a/b@v1'),
      ]);
    });

    it('値を折り返す書き方（>- / |）は、固定していても読めないものとして落とす', () => {
      expect(messages(steps('- uses: >-', `    actions/checkout@${SHA}`))).toEqual([
        `4: ${UNREADABLE}`,
      ]);
      expect(messages(steps('- uses: |', '    actions/checkout@v7'))).toEqual([`4: ${UNREADABLE}`]);
    });

    it('値の無い uses: と、文字列でない値', () => {
      expect(messages(steps('- uses:'))).toEqual([`4: ${UNREADABLE}`]);
      expect(messages(steps('- uses: [actions/checkout@v7]'))).toEqual([`4: ${UNREADABLE}`]);
      expect(messages(steps('- uses: 42'))).toEqual([`4: ${UNREADABLE}`]);
    });

    it('uses: の値を別名（*anchor）で差し替える書き方', () => {
      const source = ['env:', '  REF: &ref actions/checkout@v7', steps('- uses: *ref')].join('\n');
      expect(messages(source)).toEqual(['6: uses: に別名（*anchor）を使わない']);
    });

    it('キーの別名とマージキーは、どの key が効くか決められないので落とす', () => {
      const keyAlias = ['env:', '  K: &k uses', steps('- *k : actions/checkout@v7')].join('\n');
      expect(messages(keyAlias)).toEqual(['6: キーに別名（*anchor）を使わない']);

      const merge = [
        'x-base: &base',
        '  uses: actions/checkout@v7',
        steps('- <<: *base', '  name: checkout'),
      ].join('\n');
      expect(messages(merge)).toEqual(['6: マージキー（<<）を使わない']);
    });

    it('jobs の直下とジョブの中のマージキーも落とす（構造をたどる mapping はどれも）', () => {
      const jobs = [
        'x-jobs: &shared-jobs',
        '  injected:',
        '    steps:',
        '      - uses: evil/action@main',
        'jobs:',
        '  <<: *shared-jobs',
        '',
      ].join('\n');
      expect(messages(jobs)).toEqual(['6: マージキー（<<）を使わない']);

      const job = [
        'x-job: &job',
        '  steps:',
        '    - uses: evil/action@main',
        'jobs:',
        '  build:',
        '    <<: *job',
        '',
      ].join('\n');
      expect(messages(job)).toEqual(['6: マージキー（<<）を使わない']);

      const root = ['x: &x', '  jobs: {}', '<<: *x', ''].join('\n');
      expect(messages(root)).toEqual(['3: マージキー（<<）を使わない']);
    });

    it('別名で差したステップ・steps・ジョブは、参照先を解決して見る', () => {
      const step = [
        'x-steps:',
        '  checkout: &checkout',
        '    uses: actions/checkout@v7',
        steps('- *checkout', '- *checkout'),
      ].join('\n');
      // 2 か所から参照しても、定義の位置で 1 回だけ知らせる。
      expect(messages(step)).toEqual([unpinned(3, 'actions/checkout@v7')]);

      const list = [
        'x-steps: &list',
        '  - uses: actions/checkout@v7',
        'jobs:',
        '  build:',
        '    steps: *list',
        '',
      ].join('\n');
      expect(messages(list)).toEqual([unpinned(2, 'actions/checkout@v7')]);

      const job = [
        'x-job: &job',
        '  uses: org/repo/.github/workflows/ci.yml@main',
        'jobs:',
        '  call: *job',
        '',
      ].join('\n');
      expect(messages(job)).toEqual([unpinned(2, 'org/repo/.github/workflows/ci.yml@main')]);
    });

    it('steps やステップが読める形でない', () => {
      expect(messages('jobs:\n  build:\n    steps: oops\n')).toEqual([
        '3: steps が配列として読めない',
      ]);
      expect(messages(steps('- just-a-string'))).toEqual(['4: ステップが mapping として読めない']);
    });

    it('composite action（runs.steps）の未固定', () => {
      const source = 'runs:\n  using: composite\n  steps:\n    - uses: evil/action@main\n';
      expect(messages(source)).toEqual([unpinned(4, 'evil/action@main')]);
    });

    it('YAML として読めないファイルは、見えない箇所を通さないために落とす', () => {
      const problems = findPinProblems('jobs:\n  build:\n    steps: [actions/checkout@v7\n');
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]?.message).toMatch(/^YAML として読めない/);
    });

    it('複数の文書（---）はどれも見る', () => {
      const pinned = steps(`- uses: actions/checkout@${SHA} # v7.0.1`);
      const source = `${pinned}---\n${steps('- uses: actions/checkout@v7')}`;
      expect(messages(source)).toEqual([unpinned(9, 'actions/checkout@v7')]);
    });
  });

  describe('既知の制限', () => {
    it('docker イメージの digest 固定（docker://…@sha256:…）も今は落とす', () => {
      // 使っていないので許可する形を持たない。使うときに PINNED を広げる。
      const digest = `sha256:${'0'.repeat(64)}`;
      expect(messages(steps(`- uses: docker://alpine@${digest}`))).toHaveLength(1);
    });
  });
});
