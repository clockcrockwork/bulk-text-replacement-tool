import type { JSX } from 'react';

export interface ToggleOption<T extends string> {
  value: T;
  label: string;
}

export interface ToggleGroupProps<T extends string> {
  /** 支援技術向けのグループ名。画面には出さない。 */
  legend: string;
  value: T;
  options: readonly ToggleOption<T>[];
  onChange: (value: T) => void;
  /** ツールバーに並べるときの、他のボタンと高さを揃えた版。 */
  tall?: boolean;
}

/**
 * 排他的な2択・3択の切り替え。
 *
 * 選択中が色だけで分かる状態にならないよう `aria-pressed` を必ず付ける。
 * `fieldset` + `legend` なのは、role="group" を素の div に付けると
 * 意味のある要素で表せるとして lint に止められるため。
 */
export function ToggleGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
  tall = false,
}: ToggleGroupProps<T>): JSX.Element {
  return (
    <fieldset className="toggle-group">
      <legend className="visually-hidden">{legend}</legend>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`toggle${tall ? ' toggle--tall' : ''}${active ? ' is-active' : ''}`}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
