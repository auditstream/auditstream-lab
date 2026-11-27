import { AuditstreamError, audit } from "@auditstream/node";
import { auditstream as honoAuditstream } from "@auditstream/node/hono";
import { auditTransaction } from "@auditstream/prisma";
import { Hono } from "hono";
import { createDemoAuditOptions, parsePositiveInt } from "../../shared/actor.js";
import {
  ERR_INVALID_INVOICE_ID,
  ERR_INVOICE_NOT_FOUND,
  getPgErrorCode,
  mountSharedInvoiceRoutes,
  parseOptionalStringField,
  readJsonBody,
  serializeInvoice,
} from "../../shared/http.js";
import type { PrismaDatabaseHandle } from "./db.js";

const isAuditError = (err: unknown): err is Error => err instanceof AuditstreamError;

async function nullIfNotFound<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (err) {
    if (getPgErrorCode(err) === "P2025") {
      return null;
    }
    throw err;
  }
}

/**
 * Builds the live Prisma 7 HTTP API wired with `@auditstream/prisma` SQL comments,
 * `auditTransaction()` `set_config` fallback, `audit.log()`, and `audit.query()`.
 */
export function createApp(handle: PrismaDatabaseHandle): Hono {
  const { prisma, pool } = handle;
  const app = new Hono();

  app.use("*", honoAuditstream(createDemoAuditOptions("lab/prisma-api")));

  mountSharedInvoiceRoutes(app, {
    appName: "prisma-api",
    createInvoice: (input) => prisma.invoice.create({ data: input }),
    updateInvoice: (id, input) =>
      nullIfNotFound(() => prisma.invoice.update({ where: { id }, data: input })),
    deleteInvoice: async (id) => {
      const deleted = await nullIfNotFound(() => prisma.invoice.delete({ where: { id } }));
      return deleted ? deleted.id : null;
    },
    logEvent: (event) =>
      auditTransaction(prisma, (tx) =>
        audit.log((sql, values) => tx.$queryRawUnsafe(sql, ...values), event),
      ),
    queryActivity: (query) => audit.query((text, values) => pool.query(text, values), query),
    isAuditError,
  });

  // Uses auditTransaction() (`set_config(..., true)` fallback -> actor_source = 'set_config').
  app.post("/invoices/:id/approve", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) {
      return c.json({ error: ERR_INVALID_INVOICE_ID }, 400);
    }
    const body = await readJsonBody(() => c.req.text());
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }
    const statusField = parseOptionalStringField(body.value, "status");
    if (!statusField.ok) {
      return c.json({ error: statusField.error }, 400);
    }
    const status = statusField.value ?? "approved";
    const updated = await nullIfNotFound(() =>
      auditTransaction(prisma, (tx) => tx.invoice.update({ where: { id }, data: { status } })),
    );
    return updated
      ? c.json(serializeInvoice(updated))
      : c.json({ error: ERR_INVOICE_NOT_FOUND }, 404);
  });

  return app;
}
