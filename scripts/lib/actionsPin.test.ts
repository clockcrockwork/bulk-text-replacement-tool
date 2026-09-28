import { describe, expect, it } from 'vitest';
import { findPinProblems } from './actionsPin.js';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

/** 1 ステップだけのワークフロー。行番号を読みやすくするため、ステップは 4 行目に来る。 */
function workflow(step: string): string {
  return ['jobs:', '  build:', '    steps:', `      ${step}`, ''].join('\n');
}

function messages(source: string): string[] {
  return findPinProblems(source).map(({ line, message }) => `${line}: ${message}`);
}

describe('findPinProblems', () => {
  describe('通すもの', () => {
    it('SHA と版の注記がある', () => {
      expect(messages(workflow(`- uses: actions/checkout@${SHA} # v7.0.1`))).toEqual([]);
    });

    it('引用した値、# の後ろに空白が無い注記、CRLF', () => {
      const source = [
        'steps:',
        `  - uses: "actions/checkout@${SHA}" # v7.0.1`,
        `  - uses: 'actions/checkout@${SHA}' #v7`,
        `  - uses: actions/checkout@${SHA} # v7.0.1`,
      ].join('\r\n');
      expect(messages(source)).toEqual([]);
    });

    it('フロー形式でも、固定して注記があれば通す', () => {
      expect(messages(workflow(`- { uses: actions/checkout@${SHA} } # v7.0.1`))).toEqual([]);
    });

    it('同じリポジトリの Action（./）は固定しなくてよい', () => {
      expect(messages(workflow('- uses: ./.github/actions/setup'))).toEqual([]);
    });

    it('再利用ワークフローも SHA と注記があれば通す', () => {
      const source = `jobs:\n  call:\n    uses: org/repo/.github/workflows/ci.yml@${SHA} # v1\n`;
      expect(messages(source)).toEqual([]);
    });

    it('コメントの中の uses: は見ない', () => {
      const source = `# uses: actions/checkout@v7\nsteps:\n  - uses: actions/checkout@${SHA} # v7.0.1 \n`;
      expect(messages(source)).toEqual([]);
    });

    it('run: の 1 行の文字列の中にある uses: は Action ではない', () => {
      // 引用しない `run: echo "uses: x"` は plain scalar に `: ` を含み、YAML として不正
      // （GitHub も読めない）。有効な書き方では値全体を引用する。
      expect(messages(workflow(`- run: 'echo "uses: something@main"'`))).toEqual([]);
    });

    it('run: | とヒアドキュメントの本文にある uses: は Action ではない', () => {
      const source = [
        'steps:',
        '  - run: |',
        "      cat <<'EOF'",
        '      uses: this-is-just-text',
        '      "uses": actions/checkout@v7',
        '      EOF',
        '  - run: >-',
        '      uses: folded-text',
        '',
      ].join('\n');
      expect(messages(source)).toEqual([]);
    });

    it('composite action（runs.steps）も同じ規則で見る', () => {
      const source = [
        'runs:',
        '  using: composite',
        '  steps:',
        `    - uses: actions/checkout@${SHA} # v7.0.1`,
        '',
      ].join('\n');
      expect(messages(source)).toEqual([]);
    });

    it('空のファイルとコメントだけのファイル', () => {
      expect(messages('')).toEqual([]);
      expect(messages('# nothing here\n')).toEqual([]);
    });
  });

  describe('落とすもの', () => {
    it('タグ・ブランチの参照', () => {
      expect(messages(workflow('- uses: actions/checkout@v7'))).toEqual([
        '4: actions/checkout@v7 がコミット SHA（40 桁）で固定されていない',
      ]);
      expect(messages(workflow('- uses: actions/checkout@main # v7'))).toEqual([
        '4: actions/checkout@main がコミット SHA（40 桁）で固定されていない',
      ]);
    });

    it('SHA が短い・大文字', () => {
      expect(messages(workflow('- uses: actions/checkout@3d3c42e # v7.0.1'))).toHaveLength(1);
      expect(
        messages(workflow(`- uses: actions/checkout@${SHA.toUpperCase()} # v7.0.1`)),
      ).toHaveLength(1);
    });

    it('SHA の後ろに版の注記が無い・崩れている', () => {
      const missing = `actions/checkout@${SHA} の後ろに版の注記（例: # v7.0.1）が無い`;
      expect(messages(workflow(`- uses: actions/checkout@${SHA}`))).toEqual([`4: ${missing}`]);
      expect(messages(workflow(`- uses: actions/checkout@${SHA} # v7.0.1 (security)`))).toEqual([
        `4: ${missing}`,
      ]);
      // 注記が次の行にあっても、Dependabot は同じ行の注記しか書き換えない。
      const nextLine = `steps:\n  - uses: actions/checkout@${SHA}\n    # v7.0.1\n`;
      expect(messages(nextLine)).toEqual([`2: ${missing}`]);
    });

    it('フロー形式の未固定', () => {
      expect(messages(workflow('- { uses: actions/checkout@v7 }'))).toEqual([
        '4: actions/checkout@v7 がコミット SHA（40 桁）で固定されていない',
      ]);
      expect(messages('steps: [{ name: x, uses: actions/checkout@v7 }]\n')).toHaveLength(1);
    });

    it('引用したキー（"uses" / \'uses\'）の未固定', () => {
      const source = [
        'steps:',
        '  - "uses": actions/checkout@v7',
        "  - 'uses': actions/setup-node@v7",
        '',
      ].join('\n');
      expect(messages(source)).toEqual([
        '2: actions/checkout@v7 がコミット SHA（40 桁）で固定されていない',
        '3: actions/setup-node@v7 がコミット SHA（40 桁）で固定されていない',
      ]);
    });

    it('値を折り返す書き方（>- / |）は、固定していても読めないものとして落とす', () => {
      const folded = `steps:\n  - uses: >-\n      actions/checkout@${SHA}\n`;
      const literal = 'steps:\n  - uses: |\n      actions/checkout@v7\n';
      const unreadable =
        'uses: を読めない書き方（1 行の `uses: owner/repo@<SHA> # vX.Y.Z` で書く）';
      expect(messages(folded)).toEqual([`2: ${unreadable}`]);
      expect(messages(literal)).toEqual([`2: ${unreadable}`]);
    });

    it('値の無い uses: と、文字列でない値', () => {
      expect(messages(workflow('- uses:'))).toHaveLength(1);
      expect(messages(workflow('- uses: [actions/checkout@v7]'))).toHaveLength(1);
      expect(messages(workflow('- uses: 42'))).toHaveLength(1);
    });

    it('別名（*anchor）で値やキーを差し替える書き方', () => {
      const valueAlias = [
        'env:',
        '  REF: &ref actions/checkout@v7',
        'steps:',
        '  - uses: *ref',
        '',
      ].join('\n');
      expect(messages(valueAlias)).toEqual(['4: uses: に別名（*anchor）を使わない']);

      const keyAlias = ['env:', '  K: &k uses', 'steps:', '  - *k : actions/checkout@v7', ''].join(
        '\n',
      );
      expect(messages(keyAlias)).toEqual(['4: キーに別名（*anchor）を使わない']);
    });

    it('アンカーを付けたステップは、定義している箇所で見る', () => {
      const source = [
        'x-steps:',
        '  checkout: &checkout',
        '    uses: actions/checkout@v7',
        'steps:',
        '  - *checkout',
        '',
      ].join('\n');
      expect(messages(source)).toEqual([
        '3: actions/checkout@v7 がコミット SHA（40 桁）で固定されていない',
      ]);
    });

    it('composite action の未固定', () => {
      const source = 'runs:\n  using: composite\n  steps:\n    - uses: evil/action@main\n';
      expect(messages(source)).toEqual([
        '4: evil/action@main がコミット SHA（40 桁）で固定されていない',
      ]);
    });

    it('YAML として読めないファイルは、見えない箇所を通さないために落とす', () => {
      const problems = findPinProblems('steps:\n  - uses: [actions/checkout@v7\n');
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]?.message).toMatch(/^YAML として読めない/);
    });

    it('複数の文書（---）はどれも見る', () => {
      const source = `uses: actions/checkout@${SHA} # v7.0.1\n---\nuses: actions/checkout@v7\n`;
      expect(messages(source)).toEqual([
        '3: actions/checkout@v7 がコミット SHA（40 桁）で固定されていない',
      ]);
    });
  });

  describe('既知の制限', () => {
    it('docker イメージの digest 固定（docker://…@sha256:…）も今は落とす', () => {
      // 使っていないので許可する形を持たない。使うときに PINNED を広げる。
      const digest = `sha256:${'0'.repeat(64)}`;
      expect(messages(workflow(`- uses: docker://alpine@${digest}`))).toHaveLength(1);
    });
  });
});
