import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  FileQuestion,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  type AriaAttributes,
  type ButtonHTMLAttributes,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import type { DocumentCheckStatus, LifecycleStatus } from "../types";
import { classNames, lifecycleCopy, statusCopy } from "../utils";

export function Button({
  variant = "primary",
  size = "md",
  loading,
  children,
  className,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  return (
    <button
      className={classNames("button", `button--${variant}`, `button--${size}`, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <LoaderCircle className="spin" size={17} aria-hidden="true" />}
      {children}
    </button>
  );
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(function IconButton({ label, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={classNames("icon-button", className)}
      aria-label={label}
      {...props}
    />
  );
});

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classNames("card", className)} {...props} />;
}

export function Badge({
  tone = "neutral",
  children,
  dot = true,
  className,
}: {
  tone?: "success" | "danger" | "warning" | "info" | "neutral" | "violet";
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={classNames("badge", `badge--${tone}`, className)}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: DocumentCheckStatus }) {
  const tone = {
    meets: "success",
    deficient: "danger",
    needs_review: "warning",
    approved_exception: "violet",
    not_submitted: "neutral",
  }[status] as "success" | "danger" | "warning" | "violet" | "neutral";
  return <Badge tone={tone}>{statusCopy[status]}</Badge>;
}

export function LifecycleBadge({ status }: { status: LifecycleStatus }) {
  const tone = {
    current: "info",
    expiring: "warning",
    expired: "danger",
    future: "violet",
    unknown: "neutral",
  }[status] as "info" | "warning" | "danger" | "violet" | "neutral";
  return <Badge tone={tone}>{lifecycleCopy[status]}</Badge>;
}

interface FieldContextValue {
  describedBy?: string;
  hasError: boolean;
  labelledBy: string;
}

const FieldContext = createContext<FieldContextValue | null>(null);

const joinIds = (...values: Array<string | undefined>): string | undefined => {
  const ids = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  return ids.length > 0 ? Array.from(new Set(ids)).join(" ") : undefined;
};

type FieldAccessibleProps = Pick<
  AriaAttributes,
  "aria-describedby" | "aria-invalid" | "aria-label" | "aria-labelledby"
>;

const fieldControlAccessibility = (
  props: FieldAccessibleProps,
  context: FieldContextValue | null,
): FieldAccessibleProps => {
  if (!context) return {};
  const hasExplicitName = Boolean(props["aria-label"] || props["aria-labelledby"]);
  return {
    "aria-describedby": joinIds(props["aria-describedby"], context.describedBy),
    "aria-invalid": props["aria-invalid"] ?? (context.hasError ? true : undefined),
    "aria-labelledby": hasExplicitName ? props["aria-labelledby"] : context.labelledBy,
  };
};

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const hintId = hint ? `${baseId}-hint` : undefined;
  const errorId = error ? `${baseId}-error` : undefined;
  const describedBy = joinIds(hintId, errorId);
  return (
    <FieldContext.Provider value={{ describedBy, hasError: Boolean(error), labelledBy: labelId }}>
      <div className={classNames("field", className)}>
        <span className="field__label" id={labelId}>
          {label}
        </span>
        {hint && (
          <span className="field__hint" id={hintId}>
            {hint}
          </span>
        )}
        {typeof children === "string" ? <TextInput value={children} readOnly /> : children}
        {error && (
          <span className="field__error" id={errorId}>
            {error}
          </span>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const context = useContext(FieldContext);
  const fallbackId = useId();
  return (
    <input
      {...props}
      {...fieldControlAccessibility(props, context)}
      id={props.id ?? fallbackId}
      className={classNames("input", className)}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const context = useContext(FieldContext);
  const fallbackId = useId();
  return (
    <textarea
      {...props}
      {...fieldControlAccessibility(props, context)}
      id={props.id ?? fallbackId}
      className={classNames("input", className)}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const context = useContext(FieldContext);
  const fallbackId = useId();
  return (
    <span className="select-wrap">
      <select
        {...props}
        {...fieldControlAccessibility(props, context)}
        id={props.id ?? fallbackId}
        className={classNames("input", "select", className)}
      >
        {children}
      </select>
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title: string;
  children: ReactNode;
}) {
  const Icon =
    tone === "success"
      ? Check
      : tone === "warning"
        ? AlertTriangle
        : tone === "danger"
          ? CircleAlert
          : FileQuestion;
  return (
    <div className={classNames("callout", `callout--${tone}`)}>
      <Icon size={20} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusableElements = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => element.getAttribute("aria-hidden") !== "true" && !element.hidden,
      );

    if (!dialogRef.current?.contains(document.activeElement)) {
      (focusableElements()[0] ?? dialogRef.current)?.focus();
    }

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.classList.remove("modal-open");
      const previous = previouslyFocusedRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className={classNames("modal", `modal--${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon ?? <FileQuestion size={25} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={classNames("skeleton", className)} aria-hidden="true" />;
}

export function PageLoader() {
  return (
    <div className="page-loader" role="status">
      <LoaderCircle className="spin" size={26} />
      <span>Loading</span>
    </div>
  );
}
