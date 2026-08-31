import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (title: string, options?: { message?: string; tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (title: string, options?: { message?: string; tone?: ToastTone }) => {
      const id = Date.now() + Math.round(Math.random() * 1_000);
      setItems((current) => [
        ...current,
        { id, title, message: options?.message, tone: options?.tone ?? "success" },
      ]);
      window.setTimeout(() => dismiss(id), 5_000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <section className="toast-region" aria-live="polite" aria-label="Notifications">
        {items.map((item) => {
          const Icon =
            item.tone === "success" ? CheckCircle2 : item.tone === "error" ? CircleAlert : Info;
          return (
            <div className={`toast toast--${item.tone}`} key={item.id}>
              <Icon size={19} aria-hidden="true" />
              <div>
                <strong>{item.title}</strong>
                {item.message && <p>{item.message}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss notification"
              >
                <X size={17} />
              </button>
            </div>
          );
        })}
      </section>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}
