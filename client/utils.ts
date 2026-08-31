import type { DocumentCheckStatus, LifecycleStatus } from "./types";

export function formatDate(value?: string | null, includeYear = true) {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(date);
}

export function formatRelativeDate(value?: string | null) {
  if (!value) return "No date";
  const date = new Date(value);
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 60) return `In ${days} days`;
  if (days < -1 && days > -60) return `${Math.abs(days)} days ago`;
  return formatDate(value);
}

export function formatMoney(minorUnits?: number | null, currency = "USD") {
  if (minorUnits === undefined || minorUnits === null) return "Not shown";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

export const statusCopy: Record<DocumentCheckStatus, string> = {
  meets: "Meets checks",
  deficient: "Deficient",
  needs_review: "Needs review",
  approved_exception: "Approved exception",
  not_submitted: "Not submitted",
};

export const lifecycleCopy: Record<LifecycleStatus, string> = {
  current: "Current document",
  expiring: "Expiring soon",
  expired: "Expired",
  future: "Future-dated",
  unknown: "Date unknown",
};

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
