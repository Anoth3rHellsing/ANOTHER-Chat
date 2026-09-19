import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try { return await client.query(text, values); } finally { client.release(); }
}

// GET /friends — list friends
router.get("/friends", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const result = await rawQuery(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.status_emoji
      FROM friendships f
      JOIN users u ON (u.id = CASE WHEN f.user1_id = $1 THEN f.user2_id ELSE f.user1_id END)
      WHERE f.user1_id = $1 OR f.user2_id = $1
      ORDER BY u.display_name
    `, [userId]);
    res.json(result.rows.map(r => ({
      id: r.id, username: r.username, displayName: r.display_name,
      avatarUrl: r.avatar_url, status: r.status, customStatus: r.custom_status, statusEmoji: r.status_emoji
    })));
});

// GET /friends/requests — incoming + outgoing
router.get("/friends/requests", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const incoming = await rawQuery(`
      SELECT fr.id, fr.sender_id, fr.created_at,
             u.username, u.display_name, u.avatar_url
      FROM friend_requests fr
      JOIN users u ON u.id = fr.sender_id
      WHERE fr.receiver_id = $1 AND fr.status = 'pending'
    `, [userId]);
    const outgoing = await rawQuery(`
      SELECT fr.id, fr.receiver_id, fr.created_at,
             u.username, u.display_name, u.avatar_url
      FROM friend_requests fr
      JOIN users u ON u.id = fr.receiver_id
      WHERE fr.sender_id = $1 AND fr.status = 'pending'
    `, [userId]);
    res.json({
      incoming: incoming.rows.map(r => ({
        id: r.id, userId: r.sender_id, username: r.username,
        displayName: r.display_name, avatarUrl: r.avatar_url, createdAt: r.created_at
      })),
      outgoing: outgoing.rows.map(r => ({
        id: r.id, userId: r.receiver_id, username: r.username,
        displayName: r.display_name, avatarUrl: r.avatar_url, createdAt: r.created_at
      })),
    });
});

// POST /friends/request — send request by username
router.post("/friends/request", requireAuth, async (req, res): Promise<void> => {
    const senderId = req.session.userId!;
    const { username } = req.body;
    if (!username?.trim()) { res.status(400).json({ error: "Nombre de usuario requerido" }); return; }

    const userRes = await rawQuery(`SELECT id FROM users WHERE username = $1`, [username.trim()]);
    if (!userRes.rows[0]) { res.status(404).json({ error: "Usuario no encontrado" }); return; }
    const receiverId = userRes.rows[0].id;
    if (receiverId === senderId) { res.status(400).json({ error: "No puedes enviarte solicitud a ti mismo" }); return; }

    // Check already friends
    const alreadyFriend = await rawQuery(`
      SELECT 1 FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)
    `, [senderId, receiverId]);
    if (alreadyFriend.rows.length > 0) { res.status(400).json({ error: "Ya son amigos" }); return; }

    // Check existing pending request
    const existing = await rawQuery(`
      SELECT 1 FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'
    `, [senderId, receiverId]);
    if (existing.rows.length > 0) { res.status(400).json({ error: "Solicitud ya enviada" }); return; }

    // If they already sent us one, auto-accept
    const theirReq = await rawQuery(`
      SELECT id FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'
    `, [receiverId, senderId]);
    if (theirReq.rows.length > 0) {
      await rawQuery(`UPDATE friend_requests SET status='accepted' WHERE id=$1`, [theirReq.rows[0].id]);
      await rawQuery(`
        INSERT INTO friendships (user1_id, user2_id) VALUES (LEAST($1,$2), GREATEST($1,$2)) ON CONFLICT DO NOTHING
      `, [senderId, receiverId]);
      res.json({ accepted: true });
      return;
    }

    await rawQuery(
      `INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [senderId, receiverId]
    );
    res.status(201).json({ sent: true });
});

// POST /friends/requests/:requestId/accept
router.post("/friends/requests/:requestId/accept", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const requestId = parseInt(req.params.requestId as string, 10);
    const reqRow = await rawQuery(`SELECT * FROM friend_requests WHERE id=$1 AND receiver_id=$2 AND status='pending'`, [requestId, userId]);
    if (!reqRow.rows[0]) { res.status(404).json({ error: "Solicitud no encontrada" }); return; }
    const { sender_id } = reqRow.rows[0];
    await rawQuery(`UPDATE friend_requests SET status='accepted' WHERE id=$1`, [requestId]);
    await rawQuery(`
      INSERT INTO friendships (user1_id, user2_id) VALUES (LEAST($1,$2), GREATEST($1,$2)) ON CONFLICT DO NOTHING
    `, [userId, sender_id]);
    res.json({ accepted: true });
});

// POST /friends/requests/:requestId/reject
router.post("/friends/requests/:requestId/reject", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const requestId = parseInt(req.params.requestId as string, 10);
    await rawQuery(`UPDATE friend_requests SET status='rejected' WHERE id=$1 AND receiver_id=$2`, [requestId, userId]);
    res.sendStatus(204);
});

// DELETE /friends/:friendId — remove friend
router.delete("/friends/:friendId", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const friendId = parseInt(req.params.friendId as string, 10);
    await rawQuery(`
      DELETE FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)
    `, [userId, friendId]);
    res.sendStatus(204);
});

// GET /friends/check/:userId — check friendship status
router.get("/friends/check/:userId", requireAuth, async (req, res): Promise<void> => {
    const myId = req.session.userId!;
    const otherId = parseInt(req.params.userId as string, 10);
    const friendship = await rawQuery(`
      SELECT 1 FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)
    `, [myId, otherId]);
    const sentReq = await rawQuery(`SELECT 1 FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'`, [myId, otherId]);
    const receivedReq = await rawQuery(`SELECT 1 FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'`, [otherId, myId]);
    res.json({
      areFriends: friendship.rows.length > 0,
      sentRequest: sentReq.rows.length > 0,
      receivedRequest: receivedReq.rows.length > 0,
    });
});

export default router;
