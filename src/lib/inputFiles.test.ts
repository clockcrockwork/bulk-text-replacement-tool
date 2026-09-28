import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ATTRIBUTE,
  ACCEPTED_EXTENSIONS,
  ACCEPTED_EXTENSIONS_LABEL,
  describeTooLargeFiles,
  isAcceptedFile,
  planFileImport,
  readInputFiles,
} from './inputFiles';
import { MAX_IMPORT_TOTAL_BYTES, MAX_INPUT_BYTES } from './inputLimits';
import { BOM } from './text';

describe('ACCEPT_ATTRIBUTE', () => {
  // 手書きにすると拡張子を足したときにダイアログのフィルタだけ古くなる。
  it('対応拡張子すべてを含む', () => {
    for (const ext of ACCEPTED_EXTENSIONS) {
      expect(ACCEPT_ATTRIBUTE).toContain(`.${ext}`);
    }
  });

  it('テキスト系の MIME も含む', () => {
    expect(ACCEPT_ATTRIBUTE).toContain('text/plain');
    expect(ACCEPT_ATTRIBUTE).toContain('text/markdown');
  });
});

describe('ACCEPTED_EXTENSIONS_LABEL', () => {
  it('画面に出す案内文を拡張子から作る', () => {
    expect(ACCEPTED_EXTENSIONS_LABEL).toBe('.md / .txt / .tex');
  });
});

describe('isAcceptedFile', () => {
  it('対応拡張子を受け入れる', () => {
    expect(isAcceptedFile('a.md')).toBe(true);
    expect(isAcceptedFile('a.txt')).toBe(true);
    expect(isAcceptedFile('a.tex')).toBe(true);
  });

  it('大文字の拡張子も受け入れる', () => {
    expect(isAcceptedFile('A.MD')).toBe(true);
  });

  it('対象外は弾く', () => {
    expect(isAcceptedFile('a.pdf')).toBe(false);
    expect(isAcceptedFile('a.markdown')).toBe(false);
    expect(isAcceptedFile('md')).toBe(false);
  });

  it('途中に拡張子が含まれるだけの名前は弾く', () => {
    expect(isAcceptedFile('a.md.zip')).toBe(false);
  });
});

describe('readInputFiles', () => {
  it('null を渡しても空で返る', async () => {
    expect(await readInputFiles(null)).toEqual({
      inputs: [],
      skipped: 0,
      tooLarge: [],
      overTotalBytes: null,
      guessedShiftJis: [],
    });
  });

  it('対応ファイルを読み込み、対象外は数えてスキップする', async () => {
    const files = [
      new File(['# あ'], 'a.md', { type: 'text/markdown' }),
      new File(['い'], 'b.txt', { type: 'text/plain' }),
      new File(['%PDF'], 'c.pdf', { type: 'application/pdf' }),
    ];
    const { inputs, skipped } = await readInputFiles(files);
    expect(skipped).toBe(1);
    expect(inputs.map((input) => input.title)).toEqual(['a.md', 'b.txt']);
    expect(inputs[0]?.text).toBe('# あ');
  });

  it('BOM 付きのファイルは BOM を落として取り込む', async () => {
    const { inputs } = await readInputFiles([new File([`${BOM}本文`], 'a.txt')]);
    expect(inputs[0]?.text).toBe('本文');
  });

  it('取り込んだ入力には一意なIDが振られる', async () => {
    const { inputs } = await readInputFiles([new File(['1'], 'a.md'), new File(['2'], 'b.md')]);
    expect(inputs[0]?.id).toMatch(/^[a-z0-9]{8}$/);
    expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
  });

  it('元の順序を保つ', async () => {
    const { inputs } = await readInputFiles([new File(['1'], 'z.md'), new File(['2'], 'a.md')]);
    expect(inputs.map((input) => input.title)).toEqual(['z.md', 'a.md']);
  });

  it('Shift_JIS として読んだファイルは名前を返す（推測だと分かるように）', async () => {
    const cp932 = new Uint8Array([0x96, 0xbc, 0x91, 0x4f]); // 「名前」
    const result = await readInputFiles([
      new File([cp932], 'old.txt'),
      new File(['ふつうの UTF-8'], 'new.txt'),
    ]);
    expect(result.guessedShiftJis).toEqual(['old.txt']);
    expect(result.inputs[0]?.text).toBe('名前');
  });
});

describe('planFileImport', () => {
  const file = (name: string, size: number) => ({ name, size });

  it('上限ちょうどは取り込み、1バイトでも超えたら読まずに外す', () => {
    const plan = planFileImport([
      file('edge.md', MAX_INPUT_BYTES),
      file('huge.md', MAX_INPUT_BYTES + 1),
    ]);
    expect(plan.accepted.map((entry) => entry.name)).toEqual(['edge.md']);
    expect(plan.tooLarge.map((entry) => entry.name)).toEqual(['huge.md']);
    expect(plan.overTotal).toBe(false);
  });

  it('対象外の拡張子は大きさに関係なく数えるだけで、上限超えには入れない', () => {
    const plan = planFileImport([file('a.pdf', MAX_INPUT_BYTES + 1), file('b.md', 1)]);
    expect(plan.unsupported).toBe(1);
    expect(plan.tooLarge).toEqual([]);
    expect(plan.totalBytes).toBe(1);
  });

  it('1件ずつは上限内でも、合計が1回の上限を超えたら1件も読まない', () => {
    const half = MAX_IMPORT_TOTAL_BYTES / 2;
    expect(planFileImport([file('a.md', half), file('b.md', half)]).overTotal).toBe(false);
    const plan = planFileImport([file('a.md', half), file('b.md', half + 1)]);
    expect(plan.overTotal).toBe(true);
    expect(plan.totalBytes).toBe(MAX_IMPORT_TOTAL_BYTES + 1);
  });

  it('上限超えで外したファイルは合計に数えない', () => {
    const plan = planFileImport([file('huge.md', MAX_INPUT_BYTES + 1), file('a.md', 10)]);
    expect(plan.totalBytes).toBe(10);
    expect(plan.overTotal).toBe(false);
  });
});

describe('readInputFiles の上限', () => {
  it('上限を超えるファイルは読まずに名前だけ返し、残りは取り込む', async () => {
    const huge = new File([new Uint8Array(MAX_INPUT_BYTES + 1)], 'huge.md');
    const result = await readInputFiles([huge, new File(['本文'], 'a.md')]);
    expect(result.tooLarge).toEqual(['huge.md']);
    expect(result.inputs.map((input) => input.title)).toEqual(['a.md']);
    expect(result.overTotalBytes).toBeNull();
  });

  it('合計が上限を超えたら1件も読まず、合計を返す', async () => {
    const half = MAX_IMPORT_TOTAL_BYTES / 2;
    const files = [
      new File([new Uint8Array(half)], 'a.md'),
      new File([new Uint8Array(half + 1)], 'b.md'),
      new File(['x'], 'c.pdf'),
    ];
    const result = await readInputFiles(files);
    expect(result.inputs).toEqual([]);
    expect(result.overTotalBytes).toBe(MAX_IMPORT_TOTAL_BYTES + 1);
    expect(result.skipped).toBe(1);
  });
});

describe('describeTooLargeFiles', () => {
  it('無ければ何も言わず、1件なら名前、複数なら件数で知らせる', () => {
    expect(describeTooLargeFiles([])).toBeNull();
    expect(describeTooLargeFiles(['huge.md'])).toBe(
      'huge.md は 5MB を超えるため取り込みませんでした',
    );
    expect(describeTooLargeFiles(['a.md', 'b.md'])).toBe(
      '2件は 5MB を超えるため取り込みませんでした',
    );
  });

  it('名前の見えない文字は見える形にする', () => {
    expect(describeTooLargeFiles(['a\u202etxt.md'])).toContain('⟨U+202E⟩');
  });
});
