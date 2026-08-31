import {
  Check,
  Clipboard,
  Code2,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCw,
  Webhook,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Modal,
  PageLoader,
  Textarea,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import type {
  ServiceAccountRecord,
  ServiceAccountScope,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "../types";
import { formatDate, formatRelativeDate, titleCase } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

const scopeOptions: Array<{ value: ServiceAccountScope; label: string }> = [
  { value: "vendors:read", label: "Read vendors" },
  { value: "vendors:write", label: "Create and update vendors" },
  { value: "certificates:read", label: "Read certificate records" },
  { value: "certificates:write", label: "Submit certificates for human review" },
  { value: "requests:read", label: "Read certificate requests" },
  { value: "requests:write", label: "Create and cancel certificate requests" },
  { value: "evidence:read", label: "Export signed evidence bundles" },
  { value: "requirements:read", label: "Read requirements" },
  { value: "compliance:read", label: "Read document compliance" },
  { value: "events:read", label: "Read ordered events" },
];

const defaultWebhookEvents = "vendor.created, vendor.updated, certificate.confirmed";

function DeliveryBadge({ status }: { status: WebhookDeliveryRecord["status"] }) {
  const tone =
    status === "succeeded"
      ? "success"
      : status === "failed" || status === "dead_letter"
        ? "danger"
        : status === "processing"
          ? "info"
          : "neutral";
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

export function IntegrationsPage() {
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const [accounts, setAccounts] = useState<ServiceAccountRecord[]>([]);
  const [endpoints, setEndpoints] = useState<WebhookEndpointRecord[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[]>([]);
  const [webhooksConfigured, setWebhooksConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const secretReturnFocusId = useRef<string | null>(null);
  const [accountName, setAccountName] = useState("");
  const [accountDescription, setAccountDescription] = useState("");
  const [scopes, setScopes] = useState<ServiceAccountScope[]>(["vendors:read"]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDescription, setWebhookDescription] = useState("");
  const [webhookEvents, setWebhookEvents] = useState(defaultWebhookEvents);

  const load = useCallback(async () => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    setError("");
    try {
      const [nextAccounts, webhookData] = await Promise.all([
        api.serviceAccounts(),
        api.webhooks(),
      ]);
      setAccounts(nextAccounts);
      setEndpoints(webhookData.endpoints);
      setDeliveries(webhookData.deliveries);
      setWebhooksConfigured(webhookData.configured);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeSecrets = useMemo(
    () =>
      accounts.reduce(
        (count, account) => count + account.secrets.filter((entry) => !entry.revokedAt).length,
        0,
      ),
    [accounts],
  );

  const toggleScope = (scope: ServiceAccountScope) => {
    setScopes((current) =>
      current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope],
    );
  };

  const runMutation = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setError("");
    try {
      await action();
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  const revealSecret = (label: string, value: string, returnFocusId: string) => {
    secretReturnFocusId.current = returnFocusId;
    setSecretCopied(false);
    setSecret({ label, value });
  };

  useEffect(() => {
    if (secret || !secretReturnFocusId.current) return;
    const returnTarget = document.getElementById(secretReturnFocusId.current);
    secretReturnFocusId.current = null;
    returnTarget?.focus();
  }, [secret]);

  const closeUnconfirmedSecret = () => {
    if (!secret) return;
    if (
      !secretCopied &&
      !window.confirm(
        "Close this one-time secret without confirming it was saved? OpenCOI cannot reveal it again.",
      )
    ) {
      return;
    }
    setSecret(null);
  };

  const createAccount = async () => {
    if (!accountName.trim() || scopes.length === 0) return;
    setWorking(true);
    setError("");
    try {
      const created = await api.createServiceAccount({
        name: accountName.trim(),
        description: accountDescription.trim() || null,
        scopes,
      });
      revealSecret(`${accountName.trim()} API token`, created.secret.token, "service-account-name");
      setAccountName("");
      setAccountDescription("");
      setScopes(["vendors:read"]);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  const rotateAccount = async (account: ServiceAccountRecord) => {
    setWorking(true);
    setError("");
    try {
      const rotated = await api.rotateServiceAccount(account.id);
      revealSecret(
        `${account.name} replacement API token`,
        rotated.secret.token,
        `rotate-account-${account.id}`,
      );
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  const createWebhook = async () => {
    const eventTypes = webhookEvents
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!webhookUrl.trim() || eventTypes.length === 0) return;
    setWorking(true);
    setError("");
    try {
      const created = await api.createWebhook({
        url: webhookUrl.trim(),
        description: webhookDescription.trim() || null,
        eventTypes,
      });
      revealSecret("Webhook signing secret", created.signingSecret, "webhook-url");
      setWebhookUrl("");
      setWebhookDescription("");
      setWebhookEvents(defaultWebhookEvents);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <PageLoader />;
  if (!canManage) {
    return (
      <Callout tone="warning" title="Administrator access required">
        Only organization owners and administrators can manage service accounts and webhook
        destinations.
      </Callout>
    );
  }

  return (
    <div className="integrations-page">
      <PageHeading
        title="API & webhooks"
        description="Connect OpenCOI without sharing a human password. Tokens are tenant-bound, scoped, rotatable, and stored only as hashes."
        actions={
          <>
            <a
              className="button button--secondary button--md"
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              <Code2 size={16} /> OpenAPI 3.1
            </a>
            <Button variant="quiet" onClick={() => void load()}>
              <RefreshCw size={16} /> Refresh
            </Button>
          </>
        }
      />

      {error && <PageError message={error} onRetry={() => void load()} />}
      <Modal
        open={Boolean(secret)}
        title={`${secret?.label ?? "One-time secret"} — shown once`}
        description="Copy this secret to its approved destination now. OpenCOI stores no retrievable copy and cannot show it again."
        onClose={closeUnconfirmedSecret}
        size="sm"
        footer={
          <div className="one-time-secret">
            <div>
              <Button
                size="sm"
                onClick={async () => {
                  if (!secret) return;
                  try {
                    await navigator.clipboard.writeText(secret.value);
                    setSecretCopied(true);
                  } catch {
                    setError("The browser could not copy the secret. Select and copy it manually.");
                  }
                }}
              >
                <Clipboard size={14} /> Copy secret
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setSecretCopied(true);
                  setSecret(null);
                }}
              >
                I saved it
              </Button>
            </div>
          </div>
        }
      >
        {secret && (
          <div className="one-time-secret">
            <Textarea readOnly rows={3} value={secret.value} aria-label={secret.label} />
            <p role="status" aria-live="polite">
              {secretCopied ? "Secret copied to the clipboard." : "Select and copy the full value."}
            </p>
          </div>
        )}
      </Modal>

      <section className="integration-stats" aria-label="Integration status">
        <Card>
          <KeyRound size={19} />
          <div>
            <strong>{accounts.length}</strong>
            <span>service accounts</span>
          </div>
        </Card>
        <Card>
          <Check size={19} />
          <div>
            <strong>{activeSecrets}</strong>
            <span>active credentials</span>
          </div>
        </Card>
        <Card>
          <Webhook size={19} />
          <div>
            <strong>{endpoints.filter((endpoint) => endpoint.status === "active").length}</strong>
            <span>active webhooks</span>
          </div>
        </Card>
      </section>

      <div className="integration-columns">
        <Card className="integration-create-card">
          <header>
            <KeyRound size={19} />
            <div>
              <h3>Create service account</h3>
              <p>Grant only the scopes this system needs.</p>
            </div>
          </header>
          <Field label="Account name">
            <TextInput
              id="service-account-name"
              value={accountName}
              maxLength={120}
              placeholder="ERP compliance sync"
              onChange={(event) => setAccountName(event.target.value)}
            />
          </Field>
          <Field label="Description" hint="Optional operational owner or purpose.">
            <TextInput
              value={accountDescription}
              maxLength={2000}
              onChange={(event) => setAccountDescription(event.target.value)}
            />
          </Field>
          <fieldset className="scope-picker">
            <legend>Scopes</legend>
            {scopeOptions.map((scope) => (
              <label key={scope.value}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope.value)}
                  onChange={() => toggleScope(scope.value)}
                />
                <span>{scope.label}</span>
                <code>{scope.value}</code>
              </label>
            ))}
          </fieldset>
          <Button
            disabled={!accountName.trim() || scopes.length === 0}
            loading={working}
            onClick={createAccount}
          >
            <Plus size={16} /> Create & reveal token
          </Button>
        </Card>

        <Card className="integration-create-card">
          <header>
            <Webhook size={19} />
            <div>
              <h3>Create webhook endpoint</h3>
              <p>Standard Webhooks HMAC signatures, durable retries, and dead letters.</p>
            </div>
          </header>
          {!webhooksConfigured && (
            <Callout tone="warning" title="Encryption key required">
              Set a stable TOKEN_PEPPER of at least 32 bytes, then restart OpenCOI. It encrypts
              webhook signing secrets at rest.
            </Callout>
          )}
          <Field label="Public HTTPS URL">
            <TextInput
              id="webhook-url"
              type="url"
              value={webhookUrl}
              placeholder="https://example.com/hooks/opencoi"
              onChange={(event) => setWebhookUrl(event.target.value)}
            />
          </Field>
          <Field label="Description">
            <TextInput
              value={webhookDescription}
              onChange={(event) => setWebhookDescription(event.target.value)}
            />
          </Field>
          <Field label="Event types" hint="Comma-separated exact event types, or * for all.">
            <Textarea
              rows={3}
              value={webhookEvents}
              onChange={(event) => setWebhookEvents(event.target.value)}
            />
          </Field>
          <Button
            disabled={!webhooksConfigured || !webhookUrl.trim()}
            loading={working}
            onClick={createWebhook}
          >
            <Plus size={16} /> Create & reveal signing secret
          </Button>
        </Card>
      </div>

      <section className="integration-section" aria-labelledby="service-accounts-title">
        <div>
          <h3 id="service-accounts-title">Service accounts</h3>
          <p>Rotation overlaps credentials so integrations can change keys without downtime.</p>
        </div>
        {accounts.length === 0 ? (
          <Card className="integration-empty">No service accounts yet.</Card>
        ) : (
          <div className="integration-records">
            {accounts.map((account) => (
              <Card key={account.id} className="integration-record">
                <header>
                  <div>
                    <strong>{account.name}</strong>
                    <span>{account.description || "No description"}</span>
                  </div>
                  <Badge tone={account.status === "active" ? "success" : "neutral"}>
                    {account.status}
                  </Badge>
                </header>
                <div className="scope-tags">
                  {account.scopes.map((scope) => (
                    <code key={scope}>{scope}</code>
                  ))}
                </div>
                <p>
                  Created {formatDate(account.createdAt)} · last used{" "}
                  {account.lastUsedAt ? formatRelativeDate(account.lastUsedAt) : "never"}
                </p>
                <ul className="secret-list">
                  {account.secrets.map((entry) => (
                    <li key={entry.id}>
                      <code>{entry.tokenPrefix}…</code>
                      <span>
                        {entry.revokedAt
                          ? "Revoked"
                          : entry.expiresAt
                            ? `Expires ${formatDate(entry.expiresAt)}`
                            : "No expiry"}
                      </span>
                      {!entry.revokedAt && (
                        <Button
                          variant="quiet"
                          size="sm"
                          disabled={working}
                          aria-label={`Revoke credential ${entry.tokenPrefix} for ${account.name}`}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Revoke credential ${entry.tokenPrefix} for ${account.name}? Clients using it will immediately lose access. This cannot be undone.`,
                              )
                            ) {
                              return;
                            }
                            void runMutation(() =>
                              api.revokeServiceAccountSecret(account.id, entry.id),
                            );
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                <footer>
                  <Button
                    id={`rotate-account-${account.id}`}
                    variant="quiet"
                    size="sm"
                    disabled={working}
                    onClick={() => void rotateAccount(account)}
                  >
                    <RotateCw size={14} /> Rotate
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={working}
                    aria-label={`${account.status === "active" ? "Disable" : "Enable"} service account ${account.name}`}
                    onClick={() => {
                      const nextStatus = account.status === "active" ? "disabled" : "active";
                      if (
                        nextStatus === "disabled" &&
                        !window.confirm(
                          `Disable service account ${account.name}? All of its active credentials will stop authenticating until the account is enabled again.`,
                        )
                      ) {
                        return;
                      }
                      void runMutation(() => api.setServiceAccountStatus(account.id, nextStatus));
                    }}
                  >
                    {account.status === "active" ? <X size={14} /> : <Check size={14} />}
                    {account.status === "active" ? "Disable" : "Enable"}
                  </Button>
                </footer>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="integration-section" aria-labelledby="webhooks-title">
        <div>
          <h3 id="webhooks-title">Webhook endpoints</h3>
          <p>Targets are re-resolved and checked for private addresses on every delivery.</p>
        </div>
        {endpoints.length === 0 ? (
          <Card className="integration-empty">No webhook endpoints yet.</Card>
        ) : (
          <div className="integration-records">
            {endpoints.map((endpoint) => (
              <Card key={endpoint.id} className="integration-record">
                <header>
                  <div>
                    <strong>{endpoint.description || "Webhook endpoint"}</strong>
                    <code>{endpoint.url}</code>
                  </div>
                  <Badge tone={endpoint.status === "active" ? "success" : "neutral"}>
                    {endpoint.status}
                  </Badge>
                </header>
                <div className="scope-tags">
                  {endpoint.eventTypes.map((event) => (
                    <code key={event}>{event}</code>
                  ))}
                </div>
                <footer>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={working}
                    aria-label={`${endpoint.status === "active" ? "Disable" : "Enable"} webhook ${endpoint.description || endpoint.url}`}
                    onClick={() => {
                      const nextStatus = endpoint.status === "active" ? "disabled" : "active";
                      if (
                        nextStatus === "disabled" &&
                        !window.confirm(
                          `Disable webhook ${endpoint.description || endpoint.url}? New events will no longer be delivered until it is enabled again.`,
                        )
                      ) {
                        return;
                      }
                      void runMutation(() => api.setWebhookStatus(endpoint.id, nextStatus));
                    }}
                  >
                    {endpoint.status === "active" ? "Disable" : "Enable"}
                  </Button>
                </footer>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="integration-section" aria-labelledby="deliveries-title">
        <div>
          <h3 id="deliveries-title">Recent webhook deliveries</h3>
          <p>
            Stable event IDs are retained across retries. Dead letters can be replayed explicitly.
          </p>
        </div>
        <Card className="delivery-table-card">
          {deliveries.length === 0 ? (
            <div className="integration-empty">No deliveries yet.</div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Last result</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>
                        <code>{delivery.eventType}</code>
                        <span>{delivery.eventId}</span>
                      </td>
                      <td>{delivery.endpointUrl}</td>
                      <td>
                        <DeliveryBadge status={delivery.status} />
                      </td>
                      <td>{delivery.attemptCount}</td>
                      <td>{delivery.responseStatus ?? delivery.errorMessage ?? "Pending"}</td>
                      <td>
                        {["failed", "dead_letter"].includes(delivery.status) && (
                          <Button
                            variant="quiet"
                            size="sm"
                            disabled={working}
                            onClick={() =>
                              void runMutation(() => api.replayWebhookDelivery(delivery.id))
                            }
                          >
                            <RotateCw size={13} /> Replay
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
