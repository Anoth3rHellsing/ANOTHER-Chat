import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { foreignKey, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { channels } from "./channels";
import { users } from "./users";

export const channelFiles = pgTable("channel_files", {
  id: serial().primaryKey().notNull(),
  channelId: integer("channel_id").notNull(),
  uploadedBy: integer("uploaded_by").notNull(),
  filename: text().notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text().notNull(),
  storageKey: text("storage_key").notNull(),
  scanStatus: text("scan_status").notNull().default("not_started"),
  scanSource: text("scan_source"),
  scanHarmless: integer("scan_harmless"),
  scanUndetected: integer("scan_undetected"),
  scanSuspicious: integer("scan_suspicious"),
  scanMalicious: integer("scan_malicious"),
  scanSubmittedBy: integer("scan_submitted_by"),
  scanSubmittedAt: timestamp("scan_submitted_at", { withTimezone: true, mode: "date" }),
  scanCompletedAt: timestamp("scan_completed_at", { withTimezone: true, mode: "date" }),
  scanAnalysisId: text("scan_analysis_id"),
  scanError: text("scan_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (t) => [
  index("channel_files_channel_id_created_at_idx").on(t.channelId, t.createdAt),
  index("channel_files_sha256_idx").on(t.sha256),
  foreignKey({ columns: [t.channelId], foreignColumns: [channels.id], name: "channel_files_channel_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.uploadedBy], foreignColumns: [users.id], name: "channel_files_uploaded_by_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.scanSubmittedBy], foreignColumns: [users.id], name: "channel_files_scan_submitted_by_fkey" }).onDelete("set null"),
]);

export const channelFileUploads = pgTable("channel_file_uploads", {
  id: text().primaryKey().notNull(),
  channelId: integer("channel_id").notNull(),
  uploadedBy: integer("uploaded_by").notNull(),
  filename: text().notNull(),
  expectedBytes: integer("expected_bytes").notNull(),
  receivedBytes: integer("received_bytes").notNull().default(0),
  storageKey: text("storage_key").notNull(),
  completedFileId: integer("completed_file_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (t) => [
  index("channel_file_uploads_expires_at_idx").on(t.expiresAt),
  foreignKey({ columns: [t.channelId], foreignColumns: [channels.id], name: "channel_file_uploads_channel_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.uploadedBy], foreignColumns: [users.id], name: "channel_file_uploads_uploaded_by_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.completedFileId], foreignColumns: [channelFiles.id], name: "channel_file_uploads_completed_file_id_fkey" }).onDelete("cascade"),
]);

export const virusTotalRequests = pgTable("virus_total_requests", {
  id: serial().primaryKey().notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (t) => [index("virus_total_requests_requested_at_idx").on(t.requestedAt)]);

export const channelFilesTable = channelFiles;
export const channelFileUploadsTable = channelFileUploads;
export const virusTotalRequestsTable = virusTotalRequests;
export const insertChannelFileSchema = createInsertSchema(channelFilesTable).omit({ id: true, createdAt: true });
export type InsertChannelFile = z.infer<typeof insertChannelFileSchema>;
export type ChannelFile = typeof channelFilesTable.$inferSelect;