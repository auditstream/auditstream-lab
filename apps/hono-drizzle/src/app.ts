import { AuditstreamError, audit } from "@auditstream/node";
import { auditstream } from "@auditstream/node/hono";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDemoAuditOptions } from "../../shared/actor.js";
import {
  ERR_INVOICE_NOT_FOUND,
  getPgErrorCode,
  mountSharedInvoiceRoutes,
  parseInvoiceLineItemRequest,
  serializeInvoice,
} from "../../shared/http.js";
import type { DatabaseHandle } from "./db.js";
import { invoice, lineItem } from "./schema.js";

class SimulatedRollbackError extends Error {
  readonly scope: "savepoint" | "transaction";
  constructor(scope: "savepoint" | "transaction") {
    super(`Simulated ${scope} rollback`);
    this.scope = scope;
  }
}

const isAuditError = (err: unknown): err is Error => err instanceof AuditstreamError;

/**
 * Builds the live Hono + Drizzle HTTP API wired with `@auditstream/node/hono` and `wrapPgPool`.
 */
export function createApp(handle: DatabaseHandle): Hono {
  const { db, pool } = handle;
  const app = new Hono();

  app.use("*", auditstream(createDemoAuditOptions("lab/hono-drizzle")));

  mountSharedInvoiceRoutes(app, {
    appName: "hono-drizzle",
    createInvoice: async (input) => (await db.insert(invoice).values(input).returning())[0] ?? null,
    updateInvoice: async (id, input) =>
      (await db.update(invoice).set(input).where(eq(invoice.id, id)).returning())[0] ?? null,
    deleteInvoice: async (id) =>
      (await db.delete(invoice).where(eq(invoice.id, id)).returning())[0]?.id ?? null,
    logEvent: (event) => audit.log((text, values) => pool.query(text, values), event),
    queryActivity: (query) => audit.query((text, values) => pool.query(text, values), query),
    isAuditError,
  });

  app.post("/invoices/:id/finalize", async (c) => {
    const res = await handleFinalizeInvoice(db, c.req.param("id"), () => c.req.text());
    return c.json(res.body, res.status);
  });

  // Raw SQL route outside Drizzle's query builder — proves wrapPgPool tags direct pool queries.
  app.post("/invoices/:id/raw-note", async (c) => {
    const res = await handleRawNote(pool, c.req.param("id"), () => c.req.text());
    return c.json(res.body, res.status);
  });

  return app;
}

async function handleFinalizeInvoice(
  db: DatabaseHandle["db"],
  rawId: string,
  readText: () => Promise<string>,
) {
  const parsed = await parseInvoiceLineItemRequest(rawId, readText, "Finalized balance", "100.00");
  if (!parsed.ok) {
    return parsed.response;
  }

  const simulateSavepointRollback = parsed.body.simulateSavepointRollback === true;
  const simulateTxRollback = parsed.body.simulateTxRollback === true;

  try {
    const result = await db.transaction(async (tx) => {
      const [updatedInvoice] = await tx
        .update(invoice)
        .set({ status: "finalized", total: parsed.amount })
        .where(eq(invoice.id, parsed.id))
        .returning();
      if (!updatedInvoice) {
        return null;
      }
      const createdItem = await tx.transaction(async (sp) => {
        const [item] = await sp
          .insert(lineItem)
          .values({
            invoiceId: parsed.id,
            description: parsed.description,
            amount: parsed.amount,
          })
          .returning();
        return item;
      });
      const rolledBackSavepoint = simulateSavepointRollback
        ? await runRolledBackSavepoint(tx, parsed.id)
        : false;
      if (simulateTxRollback) {
        throw new SimulatedRollbackError("transaction");
      }
      return {
        invoice: serializeInvoice(updatedInvoice),
        lineItem: createdItem ?? null,
        rolledBackSavepoint,
      };
    });

    return result
      ? { status: 200 as const, body: result }
      : { status: 404 as const, body: { error: ERR_INVOICE_NOT_FOUND } };
  } catch (err) {
    if (err instanceof SimulatedRollbackError && err.scope === "transaction") {
      return { status: 409 as const, body: { rolledBack: true, id: parsed.id } };
    }
    throw err;
  }
}

async function handleRawNote(
  pool: DatabaseHandle["pool"],
  rawId: string,
  readText: () => Promise<string>,
) {
  const parsed = await parseInvoiceLineItemRequest(rawId, readText, "Raw SQL note", "1.00");
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const res = await pool.query<{
      id: number;
      invoice_id: number;
      description: string;
      amount: string;
    }>(
      "INSERT INTO public.line_item (invoice_id, description, amount) VALUES ($1, $2, $3) RETURNING id, invoice_id, description, amount",
      [parsed.id, parsed.description, parsed.amount],
    );
    const created = res.rows[0];
    return created
      ? { status: 201 as const, body: created }
      : { status: 500 as const, body: { error: "Failed to insert line item" } };
  } catch (err) {
    if (getPgErrorCode(err) === "23503") {
      return { status: 404 as const, body: { error: ERR_INVOICE_NOT_FOUND } };
    }
    throw err;
  }
}

async function runRolledBackSavepoint(
  tx: Parameters<Parameters<DatabaseHandle["db"]["transaction"]>[0]>[0],
  invoiceId: number,
): Promise<boolean> {
  try {
    await tx.transaction(async (sp) => {
      await sp.insert(lineItem).values({
        invoiceId,
        description: "Rolled back savepoint adjustment",
        amount: "1.00",
      });
      throw new SimulatedRollbackError("savepoint");
    });
  } catch (err) {
    if (err instanceof SimulatedRollbackError && err.scope === "savepoint") {
      return true;
    }
    throw err;
  }
  return false;
}
