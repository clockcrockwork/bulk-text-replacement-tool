import type { JSX } from 'react';
import type { ToastState } from '../hooks/useToast';

interface ToastProps {
  toast: ToastState;
  onAction: () => void;
}

export function Toast({ toast, onAction }: ToastProps): JSX.Element {
  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toast.action?.onClick();
            onAction();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}
