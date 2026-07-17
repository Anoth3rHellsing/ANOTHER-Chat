import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, channelsTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  getVoiceChannelMembers,
  getAllVoiceChannelsForUser,
  joinVoiceChannel,
  leaveVoiceChannel,
  broadcast,
} from "../lib/websocket";
import { canAccessChannel } from "../lib/permissions";

const router: IRouter = Router();

function serializeVoiceMember(user: typeof usersTable.$inferSelect) {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
  };
}

async function getMemberProfiles(userIds: number[]) {
  if (userIds.length === 0) return [];
  const users = await db.select().from(usersTable).where(inArray(usersTable.id, userIds));
  return users.map(serializeVoiceMember);
}

// GET /channels/:channelId/voice — list current voice members
router.get("/channels/:channelId/voice", requireAuth, async (req, res) => {
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);
  const userId = (req.session as any).userId as number;
  const userRole = (req.session as any).userRole as string | undefined;

  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, userRole))) {
    res.status(403).json({ error: "Sin acceso" }); return;
  }

  const memberUserIds = Array.from(getVoiceChannelMembers(channelId));
  res.json(await getMemberProfiles(memberUserIds));
});

// POST /channels/:channelId/voice/join — join a voice channel
router.post("/channels/:channelId/voice/join", requireAuth, async (req, res) => {
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);
  const userId = (req.session as any).userId as number;
  const userRole = (req.session as any).userRole as string | undefined;

  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, userRole))) {
    res.status(403).json({ error: "Sin acceso" }); return;
  }
  if (channel.channelType !== "voice") {
    res.status(400).json({ error: "No es un canal de voz" }); return;
  }

  // Leave any other voice channels first (one channel at a time)
  const prevChannels = getAllVoiceChannelsForUser(userId);
  for (const prevChId of prevChannels) {
    if (prevChId !== channelId) {
      leaveVoiceChannel(prevChId, userId);
      broadcast(`channel:${prevChId}`, {
        type: "voice:member_leave",
        data: { channelId: prevChId, userId },
      });
    }
  }

  joinVoiceChannel(channelId, userId);

  // Broadcast join event with user profile
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (user) {
    broadcast(`channel:${channelId}`, {
      type: "voice:member_join",
      data: { channelId, member: serializeVoiceMember(user) },
    });
  }

  // Return current member list
  const memberUserIds = Array.from(getVoiceChannelMembers(channelId));
  res.json(await getMemberProfiles(memberUserIds));
});

// POST /channels/:channelId/voice/leave — leave a voice channel
router.post("/channels/:channelId/voice/leave", requireAuth, async (req, res) => {
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);
  const userId = (req.session as any).userId as number;

  leaveVoiceChannel(channelId, userId);
  broadcast(`channel:${channelId}`, {
    type: "voice:member_leave",
    data: { channelId, userId },
  });

  res.status(204).send();
});

export default router;
