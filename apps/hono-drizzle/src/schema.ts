import { integer, numeric, pgTable, text } from "drizzle-orm/pg-core";

export const invoice = pgTable("invoice", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  status: text("status").notNull(),
  total: numeric("total", { precision: 12, scale: 2 }).notNull().default("0.00"),
  passwordHash: text("password_hash"),
});

export const lineItem = pgTable("line_item", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
});
