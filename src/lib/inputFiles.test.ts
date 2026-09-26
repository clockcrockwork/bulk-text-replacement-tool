import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ATTRIBUTE,
  ACCEPTED_EXTENSIONS,
  ACCEPTED_EXTENSIONS_LABEL,
  isAcceptedFile,
  readInputFiles,
} from './inputFiles';
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
    expect(await readInputFiles(null)).toEqual({ inputs: [], skipped: 0, guessedShiftJis: [] });
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
