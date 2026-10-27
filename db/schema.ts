import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
// Each business record retains its own row and stable ID; the existing table name stays unchanged.
export const records = pgTable('demo_records', {
  key: text().primaryKey(),
  kind: text().notNull(),
  payload: jsonb().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
