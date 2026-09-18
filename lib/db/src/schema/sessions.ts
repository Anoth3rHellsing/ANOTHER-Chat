import { pgTable, varchar, json, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
export const sessions = pgTable("sessions", { sid: varchar().notNull(), sess: json().notNull(), expire: timestamp({ precision: 6, mode: "date" }).notNull() }, t => [primaryKey({ columns: [t.sid], name: "session_pkey" }), index("IDX_session_expire").using("btree", t.expire.asc().nullsLast().op("timestamp_ops"))]);
export const sessionsTable = sessions;
export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;