/**
 * IMA AI WhatsApp Worker â Baileys Edition
 *
 * Uses @whiskeysockets/baileys (lightweight WebSocket-based WhatsApp client)
 * instead of whatsapp-web.js (which requires Chromium/Puppeteer).
 *
 * Deploy on Railway, Render, or any Node.js host.
 */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
 Browsers,
    downloadMediaMessage,
  } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const Anthropic = require("@anthropic-ai/sdk").default;
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const { google } = require("googleapis");

const prisma = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Store Google OAuth tokens per user (userId -> { email, accessToken, refreshToken })
const userTokens = new Map();

// Quiet logger for Baileys (it's very verbose by default)
const logger = pino({ level: "warn" });

// âââ In-memory store for active WhatsApp sessions âââââââââââââââââââ

/** @type {Map<string, { socket: any, qrCode: string | null, status: string, dbUserId: string, lastHeartbeat: number, reconnectAttempts: number }>} */
const sessions = new Map();

// Directory to persist auth credentials (PRESERVED across restarts for auto-reconnect)
const AUTH_DIR = path.join(process.cwd(), ".wa-auth");
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Reconnect settings
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 2000; // 2s, doubles each attempt (exponential backoff)
const HEARTBEAT_INTERVAL_MS = 45000; // Check connection health every 45s

// âââ Express API ââââââââââââââââââââââââââââââââââââââââââââââââââââ

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:3000";
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
  next();
});

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.WORKER_API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// âââ Baileys Session Management âââââââââââââââââââââââââââââââââââââ

async function startBaileysSession(userId, dbUserId) {
  dbUserId = dbUserId || userId;
  const authDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Preserve existing session data (reconnect attempts, etc.) or create new
  const existingSession = sessions.get(userId);
  const sessionData = {
    socket: null,
    qrCode: null,
    status: "initializing",
    dbUserId,
    lastHeartbeat: Date.now(),
    reconnectAttempts: existingSession?.reconnectAttempts || 0,
  };
  sessions.set(userId, sessionData);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    // Reconnect settings
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 30000, // Baileys built-in keepalive ping every 30s
  });

  sessionData.socket = sock;

  // Save credentials whenever they update
  sock.ev.on("creds.update", saveCreds);

  // Connection state changes (QR code, open, close)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${userId}] QR code generated`);
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
        sessionData.qrCode = qrDataUrl;
        sessionData.status = "qr_ready";
      } catch (err) {
        console.error(`[${userId}] QR generation error:`, err.message);
      }
    }

    if (connection === "open") {
      console.log(`[${userId}] WhatsApp connected!`);
      sessionData.status = "connected";
      sessionData.qrCode = null;
      sessionData.reconnectAttempts = 0; // Reset on successful connection
      sessionData.lastHeartbeat = Date.now();

      // Fetch groups and store in database (async, don't block status)
      // Delay slightly to let Baileys finish init queries
      setTimeout(async () => {
        try {
          await syncGroups(dbUserId, sock);
          console.log(`[${userId}] Group sync completed successfully (dbUserId: ${dbUserId})`);
        } catch (err) {
          console.error(`[${userId}] Error syncing groups:`, err.message);
        }
      }, 5000);
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      // Only these specific codes mean "session is invalid, need fresh QR"
      const needsFreshStart =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 405;

      console.log(
        `[${userId}] Connection closed. Status: ${statusCode}. NeedsFreshStart: ${needsFreshStart}`
      );

      if (needsFreshStart) {
        // Clear bad credentials and stop â user must click Connect again
        console.log(`[${userId}] Clearing credentials for fresh QR on next connect`);
        sessionData.status = "disconnected";
        sessions.delete(userId);
        fs.rmSync(authDir, { recursive: true, force: true });
      } else {
        // ANY other disconnect (including undefined statusCode) â auto-reconnect
        const attempts = sessionData.reconnectAttempts || 0;
        if (attempts < MAX_RECONNECT_ATTEMPTS) {
          sessionData.reconnectAttempts = attempts + 1;
          sessionData.status = "reconnecting";
          // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s max
          const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts), 60000);
          console.log(`[${userId}] Reconnecting (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS}) in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
          try {
            await startBaileysSession(userId, dbUserId);
          } catch (reconnErr) {
            console.error(`[${userId}] Reconnect failed:`, reconnErr.message);
          }
        } else {
          console.log(`[${userId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Will retry on next heartbeat cycle.`);
          sessionData.status = "disconnected";
          // DON'T delete session or auth â heartbeat will try again later
        }
      }
    }
  });

  // Incoming messages
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    console.log(`[${userId}] messages.upsert: type=${type}, count=${msgs.length}`);
    if (type !== "notify") return; // Only process new messages

    for (const msg of msgs) {
      if (!msg.message) continue;
      // Note: allowing fromMe messages for now (so user can test with own messages)

      const jid = msg.key.remoteJid;
      const isGroup = jid?.endsWith("@g.us");

      // Only process and log group messages â skip private chats entirely
      if (!isGroup) continue;

      try {
        await handleIncomingMessage(dbUserId, sock, msg);
      } catch (err) {
        console.error(`[${userId}] Error processing message:`, err.message);
      }
    }
  });

  return sessionData;
}

// âââ Group Sync âââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function syncGroups(userId, sock) {
  // Fetch all groups the user is part of
  const groups = await sock.groupFetchAllParticipating();
  const groupList = Object.values(groups);

  console.log(`[${userId}] Found ${groupList.length} groups`);

  let synced = 0;
  let errors = 0;

  for (const group of groupList) {
    try {
      const dbGroup = await prisma.whatsAppGroup.upsert({
        where: { whatsappGroupId: group.id },
        update: { name: group.subject },
        create: {
          whatsappGroupId: group.id,
          name: group.subject,
          description: group.desc || null,
        },
      });

      await prisma.groupMembership.upsert({
        where: {
          userId_groupId: { userId, groupId: dbGroup.id },
        },
        update: { isActive: true },
        create: { userId, groupId: dbGroup.id, isMonitored: false },
      });

      synced++;
    } catch (err) {
      errors++;
      if (errors <= 3) {
        console.error(`[${userId}] Error syncing group "${group.subject}":`, err.message);
      }
    }
  }

  console.log(`[${userId}] Synced ${synced}/${groupList.length} groups (${errors} errors)`);
}

// âââ API Endpoints ââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * POST /sessions/:userId/start â Start a WhatsApp session
 */
app.post("/sessions/:userId/start", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { email, name, image, googleAccessToken, googleRefreshToken } = req.body || {};

  // Ensure user exists in database using raw SQL (most reliable)
  let dbUserId = userId;
  try {
    console.log(`[${userId}] Ensuring user exists... (email: ${email}, name: ${name})`);

    // Use raw SQL INSERT ... ON CONFLICT to handle all edge cases
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" (id, email, name, image, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = COALESCE($3, "User".name), "updatedAt" = NOW()`,
      userId, email || null, name || null, image || null
    );
    console.log(`[${userId}] User ensured in DB via raw SQL`);
  } catch (rawErr) {
    console.error(`[${userId}] Raw SQL user insert failed:`, rawErr.message);

    // If it failed due to email conflict, try without email
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "User" (id, name, image, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET name = COALESCE($2, "User".name), "updatedAt" = NOW()`,
        userId, name || null, image || null
      );
      console.log(`[${userId}] User ensured in DB (without email)`);
    } catch (fallbackErr) {
      console.error(`[${userId}] Fallback user insert also failed:`, fallbackErr.message);

      // Last resort: check if user exists with same email, use their ID
      if (email) {
        try {
          const rows = await prisma.$queryRawUnsafe(
            `SELECT id FROM "User" WHERE email = $1 LIMIT 1`, email
          );
          if (rows && rows.length > 0) {
            dbUserId = rows[0].id;
            console.log(`[${userId}] Found existing user by email, using dbUserId: ${dbUserId}`);
          }
        } catch (lookupErr) {
          console.error(`[${userId}] Email lookup also failed:`, lookupErr.message);
        }
      }
    }
  }

  // Store Google OAuth tokens in DB (CalendarLink) so they survive restarts
  if (googleAccessToken) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CalendarLink" (id, "userId", provider, "accessToken", "refreshToken", "isActive", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'GOOGLE', $2, $3, true, NOW(), NOW())
         ON CONFLICT ("userId", provider) DO UPDATE SET
           "accessToken" = $2,
           "refreshToken" = COALESCE($3, "CalendarLink"."refreshToken"),
           "isActive" = true,
           "updatedAt" = NOW()`,
        dbUserId, googleAccessToken, googleRefreshToken || null
      );
      userTokens.set(dbUserId, {
        email: email || null,
        accessToken: googleAccessToken,
        refreshToken: googleRefreshToken || null,
      });
      console.log(`[${userId}] Stored Google OAuth tokens in DB + memory (email: ${email}, hasRefresh: ${!!googleRefreshToken})`);
    } catch (tokenErr) {
      console.error(`[${userId}] Failed to store Google tokens:`, tokenErr.message);
      userTokens.set(dbUserId, {
        email: email || null,
        accessToken: googleAccessToken,
        refreshToken: googleRefreshToken || null,
      });
    }
  }

  // Don't create duplicate sessions
  if (sessions.has(userId)) {
    const session = sessions.get(userId);
    if (session.status === "qr_ready" && session.qrCode) {
      return res.json({ status: "qr_ready", qrCode: session.qrCode });
    }
    if (session.status === "connected") {
      return res.json({ status: "connected" });
    }
    if (session.status === "initializing") {
      return res.json({ status: "initializing" });
    }
  }

  console.log(`[${userId}] Starting new WhatsApp session... (dbUserId: ${dbUserId})`);

  try {
    const sessionData = await startBaileysSession(userId, dbUserId);
    res.json({ status: sessionData.status });
  } catch (err) {
    console.error(`[${userId}] Failed to start session:`, err.message);
    sessions.delete(userId);
    res.status(500).json({ error: "Failed to start WhatsApp session", detail: err.message });
  }
});

/**
 * GET /sessions/:userId/status â Check session status
 */
app.get("/sessions/:userId/status", authMiddleware, (req, res) => {
  const { userId } = req.params;
  const session = sessions.get(userId);

  if (!session) {
    return res.json({ status: "not_connected" });
  }

  const response = { status: session.status };
  if (session.status === "qr_ready" && session.qrCode) {
    response.qrCode = session.qrCode;
  }

  res.json(response);
});

/**
 * GET /sessions/:userId/groups â Get groups for connected user
 */
app.get("/sessions/:userId/groups", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const session = sessions.get(userId);

  if (!session || session.status !== "connected") {
    return res.json({ groups: [] });
  }

  try {
    const groups = await session.socket.groupFetchAllParticipating();
    const groupList = Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject,
      participantCount: g.participants?.length || 0,
    }));
    res.json({ groups: groupList });
  } catch (err) {
    res.status(500).json({ error: "Failed to get groups" });
  }
});

/**
 * DELETE /sessions/:userId â Disconnect session
 */
app.delete("/sessions/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const session = sessions.get(userId);

  if (session && session.socket) {
    try {
      await session.socket.logout();
    } catch {}
    sessions.delete(userId);
  }

  res.json({ status: "disconnected" });
});

/**
 * GET /health â Health check
 */
app.get("/health", (req, res) => {
  const sessionDetails = [];
  for (const [userId, session] of sessions) {
    sessionDetails.push({
      userId,
      status: session.status,
      reconnectAttempts: session.reconnectAttempts,
      lastHeartbeat: session.lastHeartbeat ? new Date(session.lastHeartbeat).toISOString() : null,
      secondsSinceHeartbeat: session.lastHeartbeat ? Math.round((Date.now() - session.lastHeartbeat) / 1000) : null,
    });
  }
  res.json({
    status: "ok",
    activeSessions: sessions.size,
    uptime: process.uptime(),
    engine: "baileys",
    heartbeatIntervalSec: HEARTBEAT_INTERVAL_MS / 1000,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    sessions: sessionDetails,
  });
});

/**
 * GET /debug-db/:userId â Check if user exists and try to create
 */
app.get("/debug-db/:userId", async (req, res) => {
  const { userId } = req.params;
  const results = {};

  try {
    // Check if user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    results.userExists = !!user;
    results.user = user ? { id: user.id, email: user.email, name: user.name } : null;

    // Count all users
    const userCount = await prisma.user.count();
    results.totalUsers = userCount;

    // List all user IDs
    const allUsers = await prisma.user.findMany({ select: { id: true, email: true }, take: 10 });
    results.allUsers = allUsers;

    // Try raw SQL insert if user doesn't exist
    if (!user) {
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "User" (id, name, "createdAt", "updatedAt") VALUES ($1, $2, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
          userId, "Test User"
        );
        results.rawInsert = "success";

        // Verify
        const check = await prisma.user.findUnique({ where: { id: userId } });
        results.userExistsAfterInsert = !!check;
      } catch (insertErr) {
        results.rawInsert = "failed";
        results.rawInsertError = insertErr.message;
      }
    }
  } catch (err) {
    results.error = err.message;
  }

  res.json(results);
});

// âââ Message Processing (Batched) ââââââââââââââââââââââââââââââââââââ

// Track which groups have pending unprocessed messages
const pendingGroups = new Set();

async function handleIncomingMessage(userId, sock, msg) {
  const jid = msg.key.remoteJid;

  // Only process group messages
  if (!jid || !jid.endsWith("@g.us")) return;

  const groupId = jid;

  // Privacy check: only process monitored groups
  const dbGroup = await prisma.whatsAppGroup.findUnique({
    where: { whatsappGroupId: groupId },
  });

  if (!dbGroup) return;

  const monitoringMembers = await prisma.groupMembership.findMany({
    where: { groupId: dbGroup.id, isActive: true, isMonitored: true },
  });

  if (monitoringMembers.length === 0) return;

   // Debug: log message types
    console.log(`[${userId}] Message keys:`, Object.keys(msg.message || {}));
  // Common fields needed for both image and text handlers
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderPhone = senderJid.split("@")[0];
    const senderName = msg.pushName || senderPhone;
    const msgId = msg.key.id || `${Date.now()}-${Math.random()}`;
    const msgTimestamp = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000);

  // Handle image messages
    const imageMsg = msg.message?.imageMessage;
    if (imageMsg) {
      const caption = imageMsg.caption || "";
      console.log(`[${userId}] Image in "${dbGroup.name}"${caption ? ` caption:
  "${caption.slice(0, 80)}"` : ""}`);
      try {
        const buffer = await downloadMediaMessage(
          msg, "buffer", {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
        const events = await parseImageWithAI(buffer, imageMsg.mimetype ||
  "image/jpeg", caption, dbGroup.name);
        console.log(`[Image] AI detected ${events.length} event(s) in
  "${dbGroup.name}"`);
        if (events.length > 0) {
          const storedMsg = await prisma.whatsAppMessage.upsert({
            where: { waMessageId: msgId },
            update: {},
            create: {
              waMessageId: msgId,
              groupId: dbGroup.id,
              senderPhone,
              senderName,
              content: caption ? `[Image] ${caption}` : "[Image]",
              timestamp: msgTimestamp,
              processed: true,
            },
          });
          for (const event of events) {
            for (const member of monitoringMembers) {
              const calendarId = await sendCalendarInvite(member.userId, event,
  dbGroup.name);
              await prisma.detectedEvent.create({
                data: {
                  userId: member.userId,
                  groupId: dbGroup.id,
                  messageId: storedMsg.id,
                  title: event.title,
                  description: event.description,
                  startTime: new Date(event.startTime),
                  endTime: event.endTime ? new Date(event.endTime) : null,
                  location: event.location || null,
                  eventType: event.eventType,
                  confidence: event.confidence,
                  status: calendarId ? "SYNCED" : "PENDING",
                  calendarId: calendarId || null,
                },
              });
            }
          }
        }
      } catch (imgErr) {
        console.error(`[${userId}] Error processing image:`, imgErr.message);
      }
      return;
    }

  // Extract message text
  const messageText =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    "";

  if (!messageText || messageText.length < 10) return;

  console.log(`[${userId}] Queued message in "${dbGroup.name}": "${messageText.slice(0, 80)}"`);


  // Store message (unprocessed)
  await prisma.whatsAppMessage.upsert({
    where: { waMessageId: msgId },
    update: {},
    create: {
      waMessageId: msgId,
      groupId: dbGroup.id,
      senderPhone,
      senderName,
      content: messageText,
      timestamp: msgTimestamp,
    },
  });

  // Process immediately (switch back to batched for production)
  console.log(`[Immediate] Processing group ${dbGroup.id} now...`);
  await processGroupBatch(dbGroup.id);
}

// Process all pending groups in a batch every 5 minutes
const BATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function processPendingGroups() {
  if (pendingGroups.size === 0) return;

  const groupIds = [...pendingGroups];
  pendingGroups.clear();

  console.log(`[Batch] Processing ${groupIds.length} group(s) with new messages...`);

  for (const groupId of groupIds) {
    try {
      await processGroupBatch(groupId);
    } catch (err) {
      console.error(`[Batch] Error processing group ${groupId}:`, err.message);
    }
  }
}

async function processGroupBatch(groupId) {
  // Get unprocessed messages
  const unprocessed = await prisma.whatsAppMessage.findMany({
    where: { groupId, processed: false },
    orderBy: { timestamp: "desc" },
    take: 30,
  });

  if (unprocessed.length === 0) return;

  const dbGroup = await prisma.whatsAppGroup.findUnique({ where: { id: groupId } });
  if (!dbGroup) return;

  const members = await prisma.groupMembership.findMany({
    where: { groupId, isActive: true, isMonitored: true },
  });

  if (members.length === 0) return;

  // Get recent messages for AI context (including already processed for context)
  const recentMessages = await prisma.whatsAppMessage.findMany({
    where: { groupId },
    orderBy: { timestamp: "desc" },
    take: 20,
  });

  console.log(`[Batch] Group "${dbGroup.name}": ${unprocessed.length} new msgs, running AI on ${recentMessages.length} for context...`);

  const events = await parseWithAI(
    recentMessages.reverse(),
    dbGroup.name,
    unprocessed[0].id
  );

  console.log(`[Batch] AI detected ${events.length} event(s) in "${dbGroup.name}"`);

  // Mark all unprocessed as processed
  await prisma.whatsAppMessage.updateMany({
    where: { id: { in: unprocessed.map((m) => m.id) } },
    data: { processed: true },
  });

  if (events.length === 0) return;

  // Create events and send calendar invites for each member
  for (const event of events) {
    for (const member of members) {
      const calendarId = await sendCalendarInvite(member.userId, event, dbGroup.name);

      await prisma.detectedEvent.create({
        data: {
          userId: member.userId,
          groupId,
          messageId: unprocessed[0].id,
          title: event.title,
          description: event.description,
          startTime: new Date(event.startTime),
          endTime: event.endTime ? new Date(event.endTime) : null,
          location: event.location || null,
          eventType: event.eventType,
          confidence: event.confidence,
          status: calendarId ? "SYNCED" : "PENDING",
          calendarId: calendarId || null,
        },
      });
    }
  }

  console.log(`[Batch] Created ${events.length} event(s) in "${dbGroup.name}" for ${members.length} member(s)`);
}

// Start batch processing timer
setInterval(processPendingGroups, BATCH_INTERVAL_MS);
console.log(`Batch processing enabled: every ${BATCH_INTERVAL_MS / 1000}s`);

// âââ Google Calendar Auto-Invite âââââââââââââââââââââââââââââââââââââ

const EVENT_EMOJIS = {
  SCHOOL_EVENT: "ð«", DEADLINE: "â°", BRING_ITEM: "ð", MEETING: "ð¤",
  TRIP: "ð", PAYMENT: "ð°", REMINDER: "ð", OTHER: "ð",
};

const EVENT_COLORS = {
  SCHOOL_EVENT: "9", DEADLINE: "11", BRING_ITEM: "5", MEETING: "7",
  TRIP: "2", PAYMENT: "6", REMINDER: "8", OTHER: "8",
};

async function sendCalendarInvite(userId, event, groupName) {
  let tokens = userTokens.get(userId);

  // If not in memory, load from DB
  if (!tokens || !tokens.accessToken) {
    try {
      const link = await prisma.calendarLink.findUnique({
        where: { userId_provider: { userId, provider: "GOOGLE" } },
      });
      if (link && link.accessToken) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        tokens = {
          email: user?.email || null,
          accessToken: link.accessToken,
          refreshToken: link.refreshToken || null,
        };
        userTokens.set(userId, tokens);
        console.log(`[${userId}] Loaded Google tokens from DB`);
      }
    } catch (dbErr) {
      console.error(`[${userId}] Failed to load tokens from DB:`, dbErr.message);
    }
  }

  // Ensure we have the user's email for attendee
  if (tokens && !tokens.email) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (user?.email) {
        tokens.email = user.email;
        userTokens.set(userId, tokens);
      }
    } catch (e) {}
  }

  if (!tokens || !tokens.accessToken) {
    console.log(`[${userId}] No Google tokens available, skipping calendar invite`);
    return null;
  }

  console.log(`[${userId}] Sending calendar invite: "${event.title}" (email: ${tokens.email || "NONE"}, hasRefresh: ${!!tokens.refreshToken})`);

  try {
    // DO NOT pass redirect URI â it's not needed for token refresh and causes invalid_request errors
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    // Always try refresh token first if available (access tokens expire after ~1hr)
    if (tokens.refreshToken) {
      try {
        oauth2Client.setCredentials({ refresh_token: tokens.refreshToken });
        const { credentials } = await oauth2Client.refreshAccessToken();
        console.log(`[${userId}] Token refreshed successfully`);
        tokens.accessToken = credentials.access_token;
        if (credentials.refresh_token) {
          tokens.refreshToken = credentials.refresh_token;
        }
        userTokens.set(userId, tokens);
        // Persist refreshed token to DB
        await prisma.$executeRawUnsafe(
          `UPDATE "CalendarLink" SET "accessToken" = $1, "refreshToken" = COALESCE($3, "CalendarLink"."refreshToken"), "updatedAt" = NOW()
           WHERE "userId" = $2 AND provider = 'GOOGLE'`,
          credentials.access_token, userId, credentials.refresh_token || null
        ).catch(() => {});
      } catch (refreshErr) {
        console.warn(`[${userId}] Token refresh failed:`, refreshErr.message);
        // Fall back to existing access token
        oauth2Client.setCredentials({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
        });
      }
    } else {
      // No refresh token, use access token directly (may be expired)
      oauth2Client.setCredentials({ access_token: tokens.accessToken });
    }

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const emoji = EVENT_EMOJIS[event.eventType] || "ð";
    const endTime = event.endTime
      ? new Date(event.endTime)
      : new Date(new Date(event.startTime).getTime() + 60 * 60 * 1000);

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: `${emoji} ${event.title}`,
        description: [
          event.description || "",
          "",
          `ð± Detected by IMA AI from "${groupName}"`,
          `ð¯ Confidence: ${Math.round(event.confidence * 100)}%`,
        ].join("\n"),
        start: {
          dateTime: new Date(event.startTime).toISOString(),
          timeZone: "Asia/Jerusalem",
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: "Asia/Jerusalem",
        },
        location: event.location || undefined,
        // No attendees â event is created directly on user's primary calendar
        // and will sync naturally to Apple Calendar, Outlook, etc.
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 30 },
          ],
        },
        colorId: EVENT_COLORS[event.eventType] || "8",
      },
    });

    console.log(`[${userId}] Calendar invite sent: "${event.title}" (id: ${res.data.id}, attendee: ${tokens.email || "NONE"}, htmlLink: ${res.data.htmlLink || "N/A"})`);
    return res.data.id;
  } catch (err) {
    console.error(`[${userId}] Calendar invite failed:`, err.message);
    // Log more details for debugging
    if (err.response) {
      console.error(`[${userId}] Calendar API error details:`, JSON.stringify(err.response.data || {}).slice(0, 300));
    }
    return null;
  }
}

// âââ AI Parsing âââââââââââââââââââââââââââââââââââââââââââââââââââââ

  async function parseImageWithAI(imageBuffer, mimeType, caption, groupName) {
    const base64 = imageBuffer.toString("base64");
    const today = new Date().toISOString().split("T")[0];

    const content = [
      {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      },
    ];

    if (caption) {
      content.push({ type: "text", text: `Image caption: "${caption}"` });
    }

    content.push({
      type: "text",
      text: `You are an AI that helps parents keep track of their kids' school
  events.

  Analyze this image from the WhatsApp group "${groupName}" and extract any
  calendar-worthy events.

  Today: ${today}

  Look for: flyers, notices, announcements, schedules, permission slips, or any
  text/info about school events, deadlines, items to bring, meetings, trips, or
  payments.

  Rules:
  - Only extract items with clear dates/times
  - If year not mentioned, assume nearest future date
  - Confidence 0.0-1.0 reflects certainty

  IMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no
  explanation. Just the raw JSON array.

  If no events found, return exactly: []

  Otherwise return:
  [{"title": "Short title", "description": "Context from image", "startTime":
  "ISO 8601", "endTime": "ISO 8601 or null", "location": "or null", "eventType":
   "SCHOOL_EVENT|DEADLINE|BRING_ITEM|MEETING|TRIP|PAYMENT|REMINDER|OTHER",
  "confidence": 0.9}]`,
    });

    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content }],
      });

      const text = response.content[0].type === "text" ?
  response.content[0].text : "";
      console.log("Image AI response:", text.slice(0, 500));

      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start === -1 || end <= start) return [];
      const cleaned = text.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
      const events = JSON.parse(cleaned);
      if (!Array.isArray(events)) return [];
      return events.filter(
        (e) => e.title && e.startTime && e.confidence >= 0.5 && !isNaN(new
  Date(e.startTime).getTime())
      );
    } catch (err) {
      console.error("Image AI parsing failed:", err.message);
      return [];
    }
  }

async function parseWithAI(messages, groupName, currentMessageId) {
  const messagesText = messages
    .map(
      (m, i) =>
        `[${i}] ${m.senderName || m.senderPhone} (${m.timestamp.toISOString()}): ${m.content}`
    )
    .join("\n");

  const today = new Date().toISOString().split("T")[0];

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `You are an AI that helps parents keep track of their kids' school events.

Analyze these WhatsApp messages from "${groupName}" and extract calendar-worthy events.

Today: ${today}

Messages:
${messagesText}

Look for: school events, deadlines, items to bring, meetings, trips, payments, and any time-sensitive info.

Rules:
- Only extract items with clear dates/times
- Skip casual chat ("thanks", "good morning", etc.)
- For "bring X" items, set the event at the actual date/time mentioned (NOT the day before)
- If year not mentioned, assume nearest future date
- Confidence 0.0-1.0 reflects certainty

IMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanation. Just the raw JSON array.

If no events found, return exactly: []

Otherwise return:
[{"title": "Short title", "description": "Context from message", "startTime": "ISO 8601", "endTime": "ISO 8601 or null", "location": "or null", "eventType": "SCHOOL_EVENT|DEADLINE|BRING_ITEM|MEETING|TRIP|PAYMENT|REMINDER|OTHER", "confidence": 0.9, "sourceMessageIndex": 0}]`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    console.log("AI raw response:", text.slice(0, 500));

    // Try to extract JSON array - handle cases where AI adds extra text
    const jsonMatch = text.match(/\[[\s\S]*?\](?=\s*$|\s*[^,\]\}\w])/);
    let events;
    if (jsonMatch) {
      try {
        events = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        // If first regex failed, try finding balanced brackets
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start !== -1 && end > start) {
          const jsonStr = text.slice(start, end + 1);
          try {
            events = JSON.parse(jsonStr);
          } catch (e2) {
            // Try removing trailing commas (common AI mistake)
            const cleaned = jsonStr.replace(/,\s*([}\]])/g, '$1');
            events = JSON.parse(cleaned);
          }
        }
      }
    } else {
      // Fallback: find first [ and last ]
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end <= start) return [];
      const jsonStr = text.slice(start, end + 1);
      const cleaned = jsonStr.replace(/,\s*([}\]])/g, '$1');
      events = JSON.parse(cleaned);
    }

    if (!Array.isArray(events)) return [];
    return events.filter(
      (e) =>
        e.title &&
        e.startTime &&
        e.confidence >= 0.5 &&
        !isNaN(new Date(e.startTime).getTime())
    );
  } catch (err) {
    console.error("AI parsing failed:", err.message);
    return [];
  }
}

// âââ Heartbeat â detect silent disconnects & auto-restore ââââââââââââ

async function heartbeat() {
  for (const [userId, session] of sessions) {
    // Skip sessions that are actively connecting or showing QR
    if (session.status === "initializing" || session.status === "qr_ready" || session.status === "reconnecting") {
      continue;
    }

    if (session.status === "connected") {
      // Check if socket is still alive by reading connection state
      try {
        const state = session.socket?.ws?.readyState;
        // WebSocket.OPEN = 1
        if (state !== 1 && state !== undefined) {
          console.log(`[${userId}] Heartbeat: WebSocket not OPEN (state=${state}), triggering reconnect`);
          session.status = "reconnecting";
          session.reconnectAttempts = 0;
          await startBaileysSession(userId, session.dbUserId);
        } else {
          session.lastHeartbeat = Date.now();
        }
      } catch (err) {
        console.error(`[${userId}] Heartbeat check failed:`, err.message);
      }
    }

    if (session.status === "disconnected") {
      // Session died and exhausted reconnect attempts â try again
      console.log(`[${userId}] Heartbeat: session is disconnected, attempting recovery...`);
      session.reconnectAttempts = 0;
      try {
        await startBaileysSession(userId, session.dbUserId);
      } catch (err) {
        console.error(`[${userId}] Heartbeat recovery failed:`, err.message);
      }
    }
  }
}

// Auto-restore sessions from saved auth credentials on startup
async function autoRestoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;

  const authDirs = fs.readdirSync(AUTH_DIR).filter((d) => {
    const fullPath = path.join(AUTH_DIR, d);
    return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, "creds.json"));
  });

  if (authDirs.length === 0) {
    console.log("[AutoRestore] No saved sessions to restore");
    return;
  }

  console.log(`[AutoRestore] Found ${authDirs.length} saved session(s), restoring...`);

  for (const userId of authDirs) {
    try {
      // Look up the dbUserId from the database
      const memberships = await prisma.groupMembership.findMany({
        where: { isActive: true },
        select: { userId: true },
        distinct: ["userId"],
      });

      // The userId in the auth dir might be the session userId or dbUserId
      // Try to find matching user
      let dbUserId = userId;

      // Try to look up user by checking CalendarLink or just use userId
      try {
        const calLink = await prisma.calendarLink.findFirst({
          where: { isActive: true },
          select: { userId: true },
        });
        if (calLink) {
          dbUserId = calLink.userId;
        }
      } catch (e) {}

      console.log(`[AutoRestore] Restoring session for ${userId} (dbUserId: ${dbUserId})`);
      await startBaileysSession(userId, dbUserId);
    } catch (err) {
      console.error(`[AutoRestore] Failed to restore session ${userId}:`, err.message);
    }
  }
}

// âââ Start ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const PORT = process.env.PORT || 3001;

// DO NOT wipe auth on startup â we need it for auto-reconnect!
// Auth credentials are preserved so sessions survive Railway redeploys.

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`IMA AI Worker v4.0 running on port ${PORT}`);
  console.log(`Engine: Baileys | Auto-calendar: enabled | Heartbeat: ${HEARTBEAT_INTERVAL_MS / 1000}s`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);

  // Auto-restore saved sessions after a short delay (let Express settle)
  setTimeout(async () => {
    try {
      await autoRestoreSessions();
    } catch (err) {
      console.error("[AutoRestore] Error:", err.message);
    }
  }, 3000);
});

// Start heartbeat monitor
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
console.log(`Heartbeat monitor enabled: every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

// Keep process alive â catch unhandled errors
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (keeping alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (keeping alive):", reason);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  for (const [userId, session] of sessions) {
    try {
      if (session.socket) await session.socket.end();
    } catch {}
  }
  await prisma.$disconnect();
  process.exit(0);
});
