import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { appendAuditEvent } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { OpenCoiDatabase } from "../db.js";
import {
  createServiceAccount,
  listServiceAccounts,
  revokeServiceAccountSecret,
  rotateServiceAccountSecret,
  SERVICE_ACCOUNT_SCOPES,
  setServiceAccountStatus,
} from "../services/serviceAccounts.js";
import {
  createWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayWebhookDelivery,
  resolvePublicWebhookTarget,
  setWebhookEndpointStatus,
} from "../services/webhooks.js";
import { asyncRoute, HttpError } from "./errors.js";
import {
  authContext,
  authenticate,
  enforceTrustedOrigin,
  requestAuditContext,
  requireCsrf,
  requireRole,
} from "./middleware.js";

interface IntegrationAdminDependencies {
  config: AppConfig;
  database: OpenCoiDatabase;
  now?: () => Date;
}

const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();

const accountSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: nullableText(2_000),
    scopes: z.array(z.enum(SERVICE_ACCOUNT_SCOPES)).min(1).max(SERVICE_ACCOUNT_SCOPES.length),
    secretExpiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const endpointSchema = z
  .object({
    url: z.url().max(2_048),
    description: nullableText(2_000),
    eventTypes: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  })
  .strict();

const data = (
  response: Parameters<Parameters<Router["get"]>[1]>[1],
  value: unknown,
  status = 200,
) => response.status(status).json({ data: value });

const encryptionKey = (config: AppConfig): string => {
  if (!config.tokenPepper) {
    throw new HttpError(
      503,
      "Webhook management requires TOKEN_PEPPER (at least 32 bytes) so signing secrets can be encrypted at rest",
    );
  }
  return config.tokenPepper;
};

const audit = (
  dependencies: IntegrationAdminDependencies,
  request: Request,
  response: Response,
  input: { action: string; entityType: string; entityId: string; metadata?: unknown },
): void => {
  const auth = authContext(response);
  appendAuditEvent(dependencies.database, auth.user.organization_id, {
    actorType: "user",
    actorUserId: auth.user.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
    ...requestAuditContext(request),
  });
};

export const createIntegrationAdminRouter = (
  dependencies: IntegrationAdminDependencies,
): Router => {
  const router = Router();
  const now = dependencies.now ?? (() => new Date());
  router.use(authenticate(dependencies.database, dependencies.config));
  router.use(enforceTrustedOrigin(dependencies.config));
  const csrf = requireCsrf(dependencies.config);
  router.use((request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) next();
    else csrf(request, response, next);
  });
  router.use(requireRole("owner", "admin"));

  router.get("/service-accounts", (_request, response) => {
    const auth = authContext(response);
    data(
      response,
      listServiceAccounts(dependencies.database, auth.user.organization_id).map((account) => ({
        id: account.id,
        name: account.name,
        description: account.description,
        scopes: account.scopes,
        status: account.status,
        lastUsedAt: account.last_used_at,
        createdAt: account.created_at,
        updatedAt: account.updated_at,
        secrets: account.secrets.map((secret) => ({
          id: secret.id,
          tokenPrefix: secret.token_prefix,
          expiresAt: secret.expires_at,
          lastUsedAt: secret.last_used_at,
          revokedAt: secret.revoked_at,
          createdAt: secret.created_at,
        })),
      })),
    );
  });

  router.post("/service-accounts", (request, response) => {
    const input = accountSchema.parse(request.body);
    const auth = authContext(response);
    if (input.secretExpiresAt && new Date(input.secretExpiresAt) <= now()) {
      throw new HttpError(400, "Secret expiration must be in the future");
    }
    const issued = createServiceAccount(dependencies.database, {
      organizationId: auth.user.organization_id,
      name: input.name,
      description: input.description ?? undefined,
      scopes: input.scopes,
      createdByUserId: auth.user.id,
      secretExpiresAt: input.secretExpiresAt ?? undefined,
      tokenPepper: dependencies.config.tokenPepper,
      at: now().toISOString(),
    });
    audit(dependencies, request, response, {
      action: "service_account.created",
      entityType: "service_account",
      entityId: issued.account.id,
      metadata: { name: issued.account.name, scopes: input.scopes },
    });
    data(
      response,
      {
        account: {
          id: issued.account.id,
          name: issued.account.name,
          description: issued.account.description,
          scopes: JSON.parse(issued.account.scopes_json),
          status: issued.account.status,
          createdAt: issued.account.created_at,
        },
        secret: issued.secret,
        warning: "Copy the token now. OpenCOI will not show it again.",
      },
      201,
    );
  });

  router.post("/service-accounts/:accountId/rotate", (request, response) => {
    const input = z
      .object({ expiresAt: z.iso.datetime({ offset: true }).nullable().optional() })
      .strict()
      .parse(request.body);
    const auth = authContext(response);
    if (input.expiresAt && new Date(input.expiresAt) <= now()) {
      throw new HttpError(400, "Secret expiration must be in the future");
    }
    const secret = rotateServiceAccountSecret(dependencies.database, {
      organizationId: auth.user.organization_id,
      serviceAccountId: String(request.params.accountId),
      createdByUserId: auth.user.id,
      expiresAt: input.expiresAt ?? undefined,
      tokenPepper: dependencies.config.tokenPepper,
      at: now().toISOString(),
    });
    audit(dependencies, request, response, {
      action: "service_account.secret_rotated",
      entityType: "service_account",
      entityId: String(request.params.accountId),
      metadata: { secretId: secret.id, expiresAt: secret.expiresAt },
    });
    data(response, {
      secret,
      warning:
        "Copy the token now. OpenCOI will not show it again. Existing secrets remain valid until revoked.",
    });
  });

  router.post("/service-accounts/:accountId/secrets/:secretId/revoke", (request, response) => {
    const auth = authContext(response);
    const changed = revokeServiceAccountSecret(
      dependencies.database,
      auth.user.organization_id,
      String(request.params.accountId),
      String(request.params.secretId),
      now().toISOString(),
    );
    if (!changed) throw new HttpError(404, "Active service-account secret not found");
    audit(dependencies, request, response, {
      action: "service_account.secret_revoked",
      entityType: "service_account",
      entityId: String(request.params.accountId),
      metadata: { secretId: String(request.params.secretId) },
    });
    response.status(204).end();
  });

  router.patch("/service-accounts/:accountId", (request, response) => {
    const input = z
      .object({ status: z.enum(["active", "disabled"]) })
      .strict()
      .parse(request.body);
    const auth = authContext(response);
    const changed = setServiceAccountStatus(
      dependencies.database,
      auth.user.organization_id,
      String(request.params.accountId),
      input.status,
      now().toISOString(),
    );
    if (!changed) throw new HttpError(404, "Service account not found");
    audit(dependencies, request, response, {
      action: "service_account.status_changed",
      entityType: "service_account",
      entityId: String(request.params.accountId),
      metadata: { status: input.status },
    });
    response.status(204).end();
  });

  router.get("/webhooks", (_request, response) => {
    const auth = authContext(response);
    const endpoints = listWebhookEndpoints(dependencies.database, auth.user.organization_id).map(
      (endpoint) => ({
        id: endpoint.id,
        url: endpoint.url,
        description: endpoint.description,
        eventTypes: endpoint.eventTypes,
        status: endpoint.status,
        createdAt: endpoint.created_at,
        updatedAt: endpoint.updated_at,
      }),
    );
    const deliveries = listWebhookDeliveries(dependencies.database, auth.user.organization_id).map(
      (delivery) => ({
        id: delivery.id,
        endpointId: delivery.endpoint_id,
        endpointUrl: delivery.endpoint_url,
        eventId: delivery.event_id,
        eventType: delivery.event_type,
        status: delivery.status,
        attemptCount: delivery.attempt_count,
        nextAttemptAt: delivery.next_attempt_at,
        responseStatus: delivery.response_status,
        responseBodyExcerpt: delivery.response_body_excerpt,
        errorMessage: delivery.error_message,
        deliveredAt: delivery.delivered_at,
        createdAt: delivery.created_at,
        updatedAt: delivery.updated_at,
      }),
    );
    data(response, {
      endpoints,
      deliveries,
      configured: Boolean(dependencies.config.tokenPepper),
    });
  });

  router.post(
    "/webhooks",
    asyncRoute(async (request, response) => {
      const input = endpointSchema.parse(request.body);
      // Resolve before persisting for fast feedback; every delivery resolves and
      // validates again to prevent DNS-rebinding attacks.
      await resolvePublicWebhookTarget(input.url);
      const auth = authContext(response);
      const created = createWebhookEndpoint(dependencies.database, {
        organizationId: auth.user.organization_id,
        url: input.url,
        description: input.description ?? undefined,
        eventTypes: input.eventTypes,
        encryptionKey: encryptionKey(dependencies.config),
        createdByUserId: auth.user.id,
        at: now().toISOString(),
      });
      audit(dependencies, request, response, {
        action: "webhook_endpoint.created",
        entityType: "webhook_endpoint",
        entityId: created.endpoint.id,
        metadata: { eventTypes: input.eventTypes },
      });
      data(
        response,
        {
          endpoint: {
            id: created.endpoint.id,
            url: created.endpoint.url,
            description: created.endpoint.description,
            eventTypes: JSON.parse(created.endpoint.event_types_json),
            status: created.endpoint.status,
            createdAt: created.endpoint.created_at,
          },
          signingSecret: created.signingSecret,
          warning: "Copy the signing secret now. OpenCOI will not show it again.",
        },
        201,
      );
    }),
  );

  router.patch("/webhooks/:endpointId", (request, response) => {
    const input = z
      .object({ status: z.enum(["active", "disabled"]) })
      .strict()
      .parse(request.body);
    const auth = authContext(response);
    const changed = setWebhookEndpointStatus(
      dependencies.database,
      auth.user.organization_id,
      String(request.params.endpointId),
      input.status,
      now().toISOString(),
    );
    if (!changed) throw new HttpError(404, "Webhook endpoint not found");
    audit(dependencies, request, response, {
      action: "webhook_endpoint.status_changed",
      entityType: "webhook_endpoint",
      entityId: String(request.params.endpointId),
      metadata: { status: input.status },
    });
    response.status(204).end();
  });

  router.post("/webhook-deliveries/:deliveryId/replay", (request, response) => {
    const auth = authContext(response);
    const changed = replayWebhookDelivery(
      dependencies.database,
      auth.user.organization_id,
      String(request.params.deliveryId),
      now().toISOString(),
    );
    if (!changed) throw new HttpError(404, "Failed or dead-letter webhook delivery not found");
    audit(dependencies, request, response, {
      action: "webhook_delivery.replayed",
      entityType: "webhook_delivery",
      entityId: String(request.params.deliveryId),
    });
    response.status(202).json({ data: { status: "pending" } });
  });

  return router;
};
