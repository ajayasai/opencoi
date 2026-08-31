import { CircleAlert, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, EmptyState } from "../components/ui";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={<CircleAlert size={25} />}
        title="We couldn’t load this view"
        description={message}
        action={
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              <RotateCcw size={16} aria-hidden="true" />
              Try again
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions && <div className="page-heading__actions">{actions}</div>}
    </div>
  );
}

export function Count({ value, label }: { value: number; label: string }) {
  return (
    <span className="count-label">
      <strong>{value}</strong>
      {label}
    </span>
  );
}
