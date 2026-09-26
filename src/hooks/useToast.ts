import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_DURATION_MS = 2400;

export interface ToastController {
  message: string | null;
  /** 画面左下に一時メッセージを出す。連続で呼ぶと最後のものだけが残る。 */
  flash: (message: string) => void;
}

export function useToast(): ToastController {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((next: string) => {
    setMessage(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), TOAST_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { message, flash };
}
