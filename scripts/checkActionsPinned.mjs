#!/usr/bin/env node
/**
 * GitHub Actions の `uses:` がコミット SHA（40 桁）で固定されているかを見る。
 * 判定は scripts/lib/actionsPin.js（理由もそちらに書いた）。ここはファイルを集めるだけ。
 *
 * 対象はワークフロー（.github/workflows）と、.github/actions 以下の composite action
 * （action.yml / action.yaml）。composite action も中で `uses:` を書けるので、同じく固定させる。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findPinProblems } from './lib/actionsPin.js';

const WORKFLOW_DIR = '.github/workflows';
const ACTIONS_DIR = '.github/actions';

const workflowFiles = existsSync(WORKFLOW_DIR)
  ? readdirSync(WORKFLOW_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(WORKFLOW_DIR, name))
  : [];
const actionFiles = existsSync(ACTIONS_DIR)
  ? readdirSync(ACTIONS_DIR, { recursive: true, encoding: 'utf8' })
      .filter((path) => /^action\.ya?ml$/.test(basename(path)))
      .map((path) => join(ACTIONS_DIR, path))
  : [];

const problems = [...workflowFiles, ...actionFiles].flatMap((file) =>
  findPinProblems(readFileSync(file, 'utf8')).map(
    ({ line, message }) => `${file}:${line}: ${message}`,
  ),
);

if (problems.length > 0) {
  console.error('GitHub Actions の固定で問題が見つかりました:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  console.error(
    'タグの指すコミットは `git ls-remote --tags https://github.com/<owner>/<repo>.git` で確かめ、',
  );
  console.error('`uses: owner/repo@<40桁の SHA> # vX.Y.Z` の形で書いてください。');
  process.exit(1);
}
