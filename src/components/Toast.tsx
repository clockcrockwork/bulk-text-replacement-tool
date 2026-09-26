import type { JSX } from 'react';

export function Toast({ message }: { message: string }): JSX.Element {
  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}
