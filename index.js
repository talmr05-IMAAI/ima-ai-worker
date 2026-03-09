/**
 * GroupCal WhatsApp Worker
 *
 * This is a long-running process that:
 * 1. Manages WhatsApp Web connections (one per user)
 * 2. Listens to group messages
 * 3. Sends them to AI for event detection
 * 4. Stores detected events in the database
 *
 * Deploy this on Railway, Render, or any server that supports
 * long-running Node.js processes (NOT Vercel/serverless).
 *
 * The main Next.js app communicates with this worker through
 * the shared PostgreSQL database + a small Express API.
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const Anthropic = require("@anthropic-ai/sdk").default;

const prisma = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory store for active WhatsApp sessions ───────────────────

/** @type {Map<string, { client: any, qrCode: string | null, status: string }>} */
const sessions = new Map();

// ─── Express API (so the Next.js app can talk to us) ────────────────

const app = express();
app.use(express.json());

// CORS for the Next.js frontend
app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:3000";
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
  next();
});

// Simple auth middleware — the Next.js app sends a shared secret
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.WORKER_API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * POST /sessions/:userId/start
 * Start a new WhatsApp session for a user. Returns a QR code to scan.
 */
app.post("/sessions/:userId/start", authMiddleware, async (req, res) => {
  const { userId } = req.params;

  // Don't create duplicate sessions
  if (sessions.has(userId)) {
    const session = sessions.get(userId);
    if (session.status === "qr_ready" && session.qrCode) {
      return res.json({ status: "qr_ready", qrCode: session.qrCode });
    }
    if (session.status === "connected") {
      return res.json({ status: "connected" });
    }
  }

  console.log(`[${userId}] Starting new WhatsApp session...`);

  try {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: userId }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
        ],
      },
    });

    const sessionData = { client, qrCode: null, status: "initializing" };
    sessions.set(userId, sessionData);

    // When QR code is generated
    client.on("qr", async (qr) => {
      console.log(`[${userId}] QR code generated`);
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      sessionData.qrCode = qrDataUrl;
      sessionData.status = "qr_ready";
    });

    // When successfully connected
    client.on("ready", async () => {
      console.log(`[${userId}] WhatsApp connected!`);
      sessionData.status = "connected";
      sessionData.qrCode = null;

      // Get all groups this user is in
      const chats = await client.getChats();
      const groups = chats.filter((c) => c.isGroup);

      console.log(`[${userId}] Found ${groups.length} groups`);

      // Store groups in database (but do NOT enable monitoring by default)
      // Users must explicitly choose which groups to monitor on the dashboard
      for (const group of groups) {
        await prisma.whatsAppGroup.upsert({
          where: { whatsappGroupId: group.id._serialized },
          update: { name: group.name },
          create: {
            whatsappGroupId: group.id._serialized,
            name: group.name,
            description: group.description || null,
          },
        });

        const dbGroup = await prisma.whatsAppGroup.findUnique({
          where: { whatsappGroupId: group.id._serialized },
        });

        if (dbGroup) {
          await prisma.groupMembership.upsert({
            where: {
              userId_groupId: { userId, groupId: dbGroup.id },
            },
            update: { isActive: true },
            // isMonitored defaults to false — user picks groups on dashboard
            create: { userId, groupId: dbGroup.id, isMonitored: false },
          });
        }
      }
    });

    // When a message is received
    client.on("message", async (message) => {
      try {
        await handleIncomingMessage(userId, message);
      } catch (err) {
        console.error(`[${userId}] Error processing message:`, err.message);
      }
    });

    // When disconnected
    client.on("disconnected", (reason) => {
      console.log(`[${userId}] Disconnected:`, reason);
      sessionData.status = "disconnected";
      sessions.delete(userId);
    });

    // Authentication failure
    client.on("auth_failure", (msg) => {
      console.error(`[${userId}] Auth failure:`, msg);
      sessionData.status = "auth_failed";
    });

    await client.initialize();

    res.json({ status: "initializing" });
  } catch (err) {
    console.error(`[${userId}] Failed to start session:`, err.message);
    sessions.delete(userId);
    res.status(500).json({ error: "Failed to start WhatsApp session" });
  }
});

/**
 * GET /sessions/:userId/status
 * Check the status of a user's WhatsApp session.
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
 * GET /sessions/:userId/groups
 * Get list of WhatsApp groups for a connected user.
 */
app.get("/sessions/:userId/groups", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const session = sessions.get(userId);

  if (!session || session.status !== "connected") {
    return res.json({ groups: [] });
  }

  try {
    const chats = await session.client.getChats();
    const groups = chats
      .filter((c) => c.isGroup)
      .map((g) => ({
        id: g.id._serialized,
        name: g.name,
        participantCount: g.participants?.length || 0,
      }));
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: "Failed to get groups" });
  }
});

/**
 * DELETE /sessions/:userId
 * Disconnect and remove a user's WhatsApp session.
 */
app.delete("/sessions/:userId", authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const session = sessions.get(userId);

  if (session) {
    try {
      await session.client.destroy();
    } catch {}
    sessions.delete(userId);
  }

  res.json({ status: "disconnected" });
});

/**
 * GET /health
 * Health check endpoint.
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeSessions: sessions.size,
    uptime: process.uptime(),
  });
});

// ─── Message Processing ─────────────────────────────────────────────

async function handleIncomingMessage(userId, message) {
  // Only process group messages
  const chat = await message.getChat();
  if (!chat.isGroup) return;

  const groupId = chat.id._serialized;

  // ─── PRIVACY CHECK: Only process groups the user opted into ───
  const dbGroup = await prisma.whatsAppGroup.findUnique({
    where: { whatsappGroupId: groupId },
  });

  if (!dbGroup) {
    // Group exists in WhatsApp but not in our DB yet — skip it.
    // It will be added to DB (without monitoring) when the user
    // opens the group picker on the dashboard.
    return;
  }

  // Check if ANY member has opted in to monitoring this group
  const monitoringMembers = await prisma.groupMembership.findMany({
    where: { groupId: dbGroup.id, isActive: true, isMonitored: true },
  });

  if (monitoringMembers.length === 0) {
    // Nobody is monitoring this group — skip entirely.
    // No message is stored, no AI is called, nothing happens.
    return;
  }

  const contact = await message.getContact();

  // Store message (only for monitored groups)
  const storedMessage = await prisma.whatsAppMessage.upsert({
    where: { waMessageId: message.id._serialized },
    update: {},
    create: {
      waMessageId: message.id._serialized,
      groupId: dbGroup.id,
      senderPhone: contact.number || "unknown",
      senderName: contact.pushname || contact.name || "Unknown",
      content: message.body || "",
      timestamp: new Date(message.timestamp * 1000),
    },
  });

  // Skip if empty or very short
  if (!message.body || message.body.length < 10) return;

  // Get recent messages for context
  const recentMessages = await prisma.whatsAppMessage.findMany({
    where: { groupId: dbGroup.id },
    orderBy: { timestamp: "desc" },
    take: 15,
  });

  // Run AI parsing
  const events = await parseWithAI(recentMessages.reverse(), chat.name, storedMessage.id);

  if (events.length === 0) {
    await prisma.whatsAppMessage.update({
      where: { id: storedMessage.id },
      data: { processed: true },
    });
    return;
  }

  // Find only users who opted in to monitoring this group
  const members = await prisma.groupMembership.findMany({
    where: { groupId: dbGroup.id, isActive: true, isMonitored: true },
  });

  // Create events for each member
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
    `[${userId}] Detected ${events.length} event(s) in "${chat.name}"`
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
      model: "claude-sonnet-4-5-20250514",
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`IMA AI Worker running on port ${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  for (const [userId, session] of sessions) {
    try {
      await session.client.destroy();
    } catch {}
  }
  await prisma.$disconnect();
  process.exit(0);
});
