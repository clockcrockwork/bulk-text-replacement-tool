import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_DURATION_MS = 2400;
/** 取り消せる操作は、押す間を取れるよう長めに出す。 */
const TOAST_WITH_ACTION_DURATION_MS = 8000;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  message: string;
  action?: ToastAction;
}

export interface ToastController {
  toast: ToastState | null;
  /** 画面左下に一時メッセージを出す。連続で呼ぶと最後のものだけが残る。 */
  flash: (message: string, action?: ToastAction) => void;
  dismiss: () => void;
}

export function useToast(): ToastController {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const flash = useCallback((message: string, action?: ToastAction) => {
    setToast(action ? { message, action } : { message });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setToast(null),
      action ? TOAST_WITH_ACTION_DURATION_MS : TOAST_DURATION_MS,
    );
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { toast, flash, dismiss };
}
