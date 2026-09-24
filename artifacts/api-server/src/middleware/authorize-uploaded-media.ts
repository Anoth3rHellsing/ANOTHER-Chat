import type { RequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";

const uploadsDirectory = path.resolve(process.cwd(), "uploads");
const inlineExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm", "ogg"]);

type MediaRow = {
  asset_type: "attachment" | "clip" | "user_asset" | "server_asset";
  message_id: number | null;
  linked_message_exists: boolean | null;
  message_channel_id: number | null;
  attachment_channel_id: number | null;
  stored_attachment_channel_id: number | null;
  attachment_claimed: boolean | null;
  uploaded_by_user_id: number | null;
  message_deleted_at: Date | null;
  server_id: number | null;
  restricted_roles: string | null;
  membership_role: string | null;
  member_role_ids: number[] | null;
};

/**
 * All uploaded-media references are resolved in one database round trip. The
 * request path, not a caller-provided id, selects the exact current DB record.
 * The single query also returns membership and restricted-channel roles so
 * loading a channel full of images does not issue a permissions-query cascade.
 */
const MEDIA_AUTHORIZATION_QUERY = `
  WITH candidates AS (
    SELECT
      'attachment'::text AS asset_type,
      a.message_id,
      m.id IS NOT NULL AS linked_message_exists,
      m.channel_id AS message_channel_id,
      CASE WHEN a.message_id IS NOT NULL THEN m.channel_id ELSE a.channel_id END AS attachment_channel_id,
      a.channel_id AS stored_attachment_channel_id,
      a.claimed AS attachment_claimed,
      a.uploaded_by_user_id,
      m.deleted_at AS message_deleted_at,
      ch.server_id,
      ch.restricted_roles
    FROM message_attachments a
    LEFT JOIN messages m ON m.id = a.message_id
    LEFT JOIN channels ch ON ch.id = COALESCE(m.channel_id, a.channel_id)
    WHERE CASE
      WHEN a.url ~ '^https?://' THEN regexp_replace(a.url, '^https?://[^/]+', '')
      ELSE a.url
    END = $1

    UNION ALL

    SELECT
      'clip'::text,
      NULL::integer,
      NULL::boolean,
      NULL::integer,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      NULL::integer,
      NULL::timestamptz,
      c.server_id,
      NULL::text
    FROM clips c
    WHERE CASE
      WHEN c.video_url ~ '^https?://' THEN regexp_replace(c.video_url, '^https?://[^/]+', '')
      ELSE c.video_url
    END = $1

    UNION ALL

    SELECT
      'user_asset'::text,
      NULL::integer,
      NULL::boolean,
      NULL::integer,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      NULL::integer,
      NULL::timestamptz,
      NULL::integer,
      NULL::text
    FROM users u
    WHERE CASE
      WHEN u.avatar_url ~ '^https?://' THEN regexp_replace(u.avatar_url, '^https?://[^/]+', '')
      ELSE u.avatar_url
    END = $1
       OR CASE
      WHEN u.banner_url ~ '^https?://' THEN regexp_replace(u.banner_url, '^https?://[^/]+', '')
      ELSE u.banner_url
    END = $1

    UNION ALL

    SELECT
      'server_asset'::text,
      NULL::integer,
      NULL::boolean,
      NULL::integer,
      NULL::integer,
      NULL::integer,
      NULL::boolean,
      NULL::integer,
      NULL::timestamptz,
      s.id,
      NULL::text
    FROM servers s
    WHERE CASE
      WHEN s.icon_url ~ '^https?://' THEN regexp_replace(s.icon_url, '^https?://[^/]+', '')
      ELSE s.icon_url
    END = $1
       OR CASE
      WHEN s.banner_url ~ '^https?://' THEN regexp_replace(s.banner_url, '^https?://[^/]+', '')
      ELSE s.banner_url
    END = $1
  )
  SELECT
    candidate.asset_type,
    candidate.message_id,
    candidate.linked_message_exists,
    candidate.message_channel_id,
    candidate.attachment_channel_id,
    candidate.stored_attachment_channel_id,
    candidate.attachment_claimed,
    candidate.uploaded_by_user_id,
    candidate.message_deleted_at,
    candidate.server_id,
    candidate.restricted_roles,
    member.role AS membership_role,
    COALESCE(
      ARRAY(
        SELECT member_role.role_id
        FROM server_member_roles member_role
        INNER JOIN server_roles role
          ON role.id = member_role.role_id
         AND role.server_id = candidate.server_id
        WHERE member_role.member_id = member.id
      ),
      ARRAY[]::integer[]
    ) AS member_role_ids
  FROM candidates candidate
  LEFT JOIN server_members member
    ON member.server_id = candidate.server_id
   AND member.user_id = $2
`;

function parseRestrictedRoleIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is number => Number.isSafeInteger(value) && value > 0)
      : [];
  } catch {
    // Match canAccessChannel's existing behavior for malformed JSON: treat it
    // as unrestricted, but still require current server membership below.
    return [];
  }
}

function hasChannelAccess(row: MediaRow, userId: number, globalRole: string | undefined): boolean {
  if (globalRole === "admin") return true;
  if (!row.membership_role) return false;
  if (row.membership_role === "owner" || row.membership_role === "admin") return true;

  const restrictedRoles = parseRestrictedRoleIds(row.restricted_roles);
  if (restrictedRoles.length === 0) return true;
  return (row.member_role_ids ?? []).some(roleId => restrictedRoles.includes(roleId));
}

function authorized(row: MediaRow, userId: number, globalRole: string | undefined): boolean {
  if (row.asset_type === "user_asset") {
    // User profiles are globally discoverable to signed-in users; requiring a
    // session prevents an old copied profile URL from becoming an anonymous
    // bearer token while preserving avatars in channels and DMs.
    return true;
  }

  if (row.asset_type === "server_asset" || row.asset_type === "clip") {
    return globalRole === "admin" || row.membership_role !== null;
  }

  if (row.asset_type !== "attachment" || row.message_deleted_at) return false;
  if (row.attachment_channel_id === null || row.server_id === null) return false;
  if (row.message_id !== null) {
    // Legacy attachments can have claimed=false or a null stored channel. They
    // remain valid only when their linked message exists and is live, and any
    // stored channel agrees with that message's actual channel.
    if (!row.linked_message_exists || row.message_channel_id === null ||
        (row.stored_attachment_channel_id !== null &&
         row.stored_attachment_channel_id !== row.message_channel_id)) {
      return false;
    }
  } else {
    // The only message-less attachment is a short-lived composer preview.
    // It remains visible solely to its uploader and while they retain access
    // to the channel in which it was uploaded.
    if (row.attachment_claimed || row.uploaded_by_user_id !== userId) return false;
  }
  return hasChannelAccess(row, userId, globalRole);
}

function getSafeFilename(reqPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(reqPath);
  } catch {
    return null;
  }

  // Only a single plain filename is ever served; encoded separators, nested
  // paths, dot segments, query-encoded tricks and NUL bytes are rejected.
  if (!decodedPath.startsWith("/") || decodedPath.slice(1).includes("/") ||
      decodedPath.includes("\\") || decodedPath.includes("\0")) {
    return null;
  }
  const filename = decodedPath.slice(1);
  if (!filename || filename === "." || filename === ".." || path.basename(filename) !== filename) {
    return null;
  }

  const resolved = path.resolve(uploadsDirectory, filename);
  return path.dirname(resolved) === uploadsDirectory ? filename : null;
}

/**
 * Private-by-default upload serving. Story media has its existing dedicated
 * expiry gate mounted before this middleware; soundboard files are rejected by
 * the preceding soundboardUploadSecurity middleware and use their own route.
 */
export const authorizeUploadedMedia: RequestHandler = async (req, res, next): Promise<void> => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.sendStatus(404);
    return;
  }
  if (!req.session.userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const filename = getSafeFilename(req.path);
  if (!filename) {
    res.sendStatus(404);
    return;
  }

  const relativeMediaPath = `/api/uploads/${filename}`;
  try {
    const result = await pool.query<MediaRow>(
      MEDIA_AUTHORIZATION_QUERY,
      [relativeMediaPath, req.session.userId],
    );
    const userId = req.session.userId;
    // A filename is not a unique identity across tables. Any ambiguity between
    // current records is rejected, even if one candidate would authorize.
    if (result.rows.length !== 1) {
      res.sendStatus(404);
      return;
    }
    const mediaRow = result.rows[0];
    if (!authorized(mediaRow, userId, req.session.userRole)) {
      res.sendStatus(404);
      return;
    }

    const filePath = path.resolve(uploadsDirectory, filename);
    if (path.dirname(filePath) !== uploadsDirectory) {
      res.sendStatus(404);
      return;
    }
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile()) {
        res.sendStatus(404);
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.sendStatus(404);
        return;
      }
      next(error);
      return;
    }

    // Re-authorize on each request and do not retain bytes in browser or shared
    // intermediary caches after a user's membership/role has changed.
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Cookie");
    const extension = path.extname(filename).slice(1).toLowerCase();
    if (!inlineExtensions.has(extension)) {
      res.setHeader("Content-Disposition", "attachment");
    }
    res.sendFile(filePath, { cacheControl: false }, error => {
      if (!error) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      next(error);
    });
  } catch (error) {
    next(error);
  }
};