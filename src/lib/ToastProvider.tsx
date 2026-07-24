import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ToastContext } from './toastContext';
import { colors, fonts, textA } from '../styles/tokens';

const TOAST_DURATION_MS = 2400;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => setMessage(null), TOAST_DURATION_MS);
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {message && (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: 16,
            right: 16,
            bottom: 20,
            background: colors.bgDark,
            color: colors.text,
            fontSize: 13.5,
            fontWeight: 600,
            fontFamily: fonts.sans,
            borderRadius: 12,
            padding: '12px 14px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            border: `1px solid ${textA(0.15)}`,
            zIndex: 1000,
            maxWidth: 480,
            margin: '0 auto',
          }}
        >
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
}
