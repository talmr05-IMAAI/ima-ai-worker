/**
 * IMA AI WhatsApp Worker — Baileys Edition
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
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const Anthropic = require("@anthropic-ai/sdk").default;
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const prisma = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Quiet logger for Baileys (it's very verbose by default)
const logger = pino({ level: "warn" });

// ─── In-memory store for active WhatsApp sessions ───────────────────

/** @type {Map<string, { socket: any, qrCode: string | null, status: string }>} */
const sessions = new Map();

// Directory to persist auth credentials
const AUTH_DIR = path.join(process.cwd(), ".wa-auth");
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ─── Express API ────────────────────────────────────────────────────

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

// ─── Baileys Session Management ─────────────────────────────────────

async function startBaileysSession(userId, dbUserId) {
  dbUserId = dbUserId || userId;
  const authDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sessionData = { socket: null, qrCode: null, status: "initializing" };
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

      // Treat 405, 401, 403, and loggedOut as "need fresh QR"
      const needsFreshStart =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 405 ||
        statusCode === 401 ||
        statusCode === 403;

      console.log(
        `[${userId}] Connection closed. Status: ${statusCode}. NeedsFreshStart: ${needsFreshStart}`
      );

      if (needsFreshStart) {
        // Clear bad credentials and stop — user must click Connect again
        console.log(`[${userId}] Clearing credentials for fresh QR on next connect`);
        sessionData.status = "disconnected";
        sessions.delete(userId);
        fs.rmSync(authDir, { recursive: true, force: true });
      } else if (statusCode !== undefined) {
        // Temporary disconnect — reconnect (max 3 attempts)
        const attempts = sessionData.reconnectAttempts || 0;
        if (attempts < 3) {
          sessionData.reconnectAttempts = attempts + 1;
          sessionData.status = "reconnecting";
          console.log(`[${userId}] Reconnecting (attempt ${attempts + 1}/3)...`);
          // Delay before reconnect to avoid hammering
          await new Promise((r) => setTimeout(r, 2000));
          await startBaileysSession(userId);
        } else {
          console.log(`[${userId}] Max reconnect attempts reached. Cleaning up.`);
          sessionData.status = "disconnected";
          sessions.delete(userId);
          fs.rmSync(authDir, { recursive: true, force: true });
        }
      } else {
        // Unknown disconnect — clean up
        sessionData.status = "disconnected";
        sessions.delete(userId);
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
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      console.log(`[${userId}] Message from ${jid} (group: ${isGroup}, len: ${text.length}): ${text.slice(0, 80)}`);

      try {
        await handleIncomingMessage(dbUserId, sock, msg);
      } catch (err) {
        console.error(`[${userId}] Error processing message:`, err.message);
      }
    }
  });

  return sessionData;
}

// ─── Group Sync ─────────────────────────────────────────────────────

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

// ─── API Endpoints ──────────────────────────────────────────────────

/**
 * POST /sessions/:userId/start — Start a WhatsApp session
 */
app.post("/sessions/:userId/start", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { email, name, image } = req.body || {};

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
 * GET /sessions/:userId/status — Check session status
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
 * GET /sessions/:userId/groups — Get groups for connected user
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
 * DELETE /sessions/:userId — Disconnect session
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
 * GET /health — Health check
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeSessions: sessions.size,
    uptime: process.uptime(),
    engine: "baileys",
  });
});

/**
 * GET /debug-db/:userId — Check if user exists and try to create
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

// ─── Message Processing ─────────────────────────────────────────────

async function handleIncomingMessage(userId, sock, msg) {
  const jid = msg.key.remoteJid;

  // Only process group messages
  if (!jid || !jid.endsWith("@g.us")) {
    console.log(`[${userId}] Skipping non-group message from ${jid}`);
    return;
  }

  const groupId = jid;

  // Privacy check: only process monitored groups
  const dbGroup = await prisma.whatsAppGroup.findUnique({
    where: { whatsappGroupId: groupId },
  });

  if (!dbGroup) {
    console.log(`[${userId}] Group ${groupId} not found in DB, skipping`);
    return;
  }

  const monitoringMembers = await prisma.groupMembership.findMany({
    where: { groupId: dbGroup.id, isActive: true, isMonitored: true },
  });

  console.log(`[${userId}] Group "${dbGroup.name}": ${monitoringMembers.length} monitoring members`);

  if (monitoringMembers.length === 0) {
    console.log(`[${userId}] No monitoring members for "${dbGroup.name}", skipping`);
    return;
  }

  // Extract message text
  const messageText =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    "";

  if (!messageText || messageText.length < 10) {
    console.log(`[${userId}] Message too short (${messageText.length} chars), skipping`);
    return;
  }

  console.log(`[${userId}] Processing message in "${dbGroup.name}": "${messageText.slice(0, 100)}"`);


  // Get sender info
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderPhone = senderJid.split("@")[0];
  const senderName = msg.pushName || senderPhone;

  // Store message
  const msgId = msg.key.id || `${Date.now()}-${Math.random()}`;
  const storedMessage = await prisma.whatsAppMessage.upsert({
    where: { waMessageId: msgId },
    update: {},
    create: {
      waMessageId: msgId,
      groupId: dbGroup.id,
      senderPhone,
      senderName,
      content: messageText,
      timestamp: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000),
    },
  });

  // Get recent messages for context
  const recentMessages = await prisma.whatsAppMessage.findMany({
    where: { groupId: dbGroup.id },
    orderBy: { timestamp: "desc" },
    take: 15,
  });

  // Run AI parsing
  console.log(`[${userId}] Running AI parsing on ${recentMessages.length} messages from "${dbGroup.name}"...`);
  const events = await parseWithAI(
    recentMessages.reverse(),
    dbGroup.name,
    storedMessage.id
  );

  console.log(`[${userId}] AI detected ${events.length} event(s) in "${dbGroup.name}"`);

  if (events.length === 0) {
    await prisma.whatsAppMessage.update({
      where: { id: storedMessage.id },
      data: { processed: true },
    });
    return;
  }

  // Create events for each monitoring member
  const members = await prisma.groupMembership.findMany({
    where: { groupId: dbGroup.id, isActive: true, isMonitored: true },
  });

  for (const event of events) {
    for (const member of members) {
      await prisma.detectedEvent.create({
        data: {
          userId: member.userId,
          groupId: dbGroup.id,
          messageId: storedMessage.id,
          title: event.title,
          description: event.description,
          startTime: new Date(event.startTime),
          endTime: event.endTime ? new Date(event.endTime) : null,
          location: event.location || null,
          eventType: event.eventType,
          confidence: event.confidence,
          status: event.confidence >= 0.7 ? "PENDING" : "PENDING",
        },
      });
    }
  }

  console.log(
    `[${userId}] Detected ${events.length} event(s) in "${dbGroup.name}"`
  );

  await prisma.whatsAppMessage.update({
    where: { id: storedMessage.id },
    data: { processed: true },
  });
}

// ─── AI Parsing ─────────────────────────────────────────────────────

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
      model: "claude-sonnet-4-6",
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
- For "bring X" items, set reminder for the day BEFORE
- If year not mentioned, assume nearest future date
- Confidence 0.0-1.0 reflects certainty

Return ONLY a JSON array (or [] if nothing found):
[{
  "title": "Short title",
  "description": "Context from message",
  "startTime": "ISO 8601",
  "endTime": "ISO 8601 or null",
  "location": "or null",
  "eventType": "SCHOOL_EVENT|DEADLINE|BRING_ITEM|MEETING|TRIP|PAYMENT|REMINDER|OTHER",
  "confidence": 0.0-1.0,
  "sourceMessageIndex": <int>
}]`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const events = JSON.parse(jsonMatch[0]);
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

// ─── Start ──────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

// Clean up any stale auth files on startup
if (fs.existsSync(AUTH_DIR)) {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  console.log("Cleared stale auth files on startup");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`IMA AI Worker running on port ${PORT}`);
  console.log(`Engine: Baileys (no Chromium needed)`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
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
