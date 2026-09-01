import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { pool } from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const POINTS = Number(process.env.POINTS_PER_PUZZLE || 5);

app.use(cors());
app.use(express.json());

const VALID_EVENT_TYPES = new Set([
  "session_start",
  "session_end",
  "puzzle_opened",
  "puzzle_solved",
  "puzzle_wrong",
  "gallery_completed",
  "stamp_collected",
  "leaderboard_viewed",
]);

app.get("/", (req, res) => {
  res.json({ status: "QR Puzzle API running" });
});

app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT user_id, name, total_score
      FROM users
      ORDER BY total_score DESC, updated_at ASC
      LIMIT 20
    `);

    res.json({
      leaderboard: result.rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        score: row.total_score,
      })),
    });
  } catch (err) {
    console.error("LEADERBOARD ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/attempt-puzzle", async (req, res) => {
  const { userId, name, email, galleryId, puzzleId } = req.body || {};

  if (!userId || !galleryId || !puzzleId) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ensure user exists
    await client.query(
      `
      INSERT INTO users (
        user_id,
        name,
        email,
        total_score,
        updated_at
      )
      VALUES ($1, $2, $3, 0, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        name = CASE
          WHEN EXCLUDED.name IS NOT NULL AND EXCLUDED.name <> ''
          THEN EXCLUDED.name
          ELSE users.name
        END,
        email = CASE
          WHEN EXCLUDED.email IS NOT NULL AND EXCLUDED.email <> ''
          THEN EXCLUDED.email
          ELSE users.email
        END,
        updated_at = NOW()
      `,
      [userId, name || "Operator", email || ""]
    );

    // insert solved puzzle
    // UNIQUE(user_id, gallery_id, puzzle_id) prevents double scoring
    const solvedResult = await client.query(
      `
      INSERT INTO solved_puzzles (
        user_id,
        gallery_id,
        puzzle_id,
        score,
        solved_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, gallery_id, puzzle_id)
      DO NOTHING
      RETURNING id
      `,
      [userId, galleryId, puzzleId, POINTS]
    );

    if (solvedResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.json({
        status: "ALREADY_SOLVED",
      });
    }

    const scoreResult = await client.query(
      `
      UPDATE users
      SET
        total_score = total_score + $2,
        updated_at = NOW()
      WHERE user_id = $1
      RETURNING total_score
      `,
      [userId, POINTS]
    );

    const newScore = scoreResult.rows[0].total_score;

    await client.query(
      `
      INSERT INTO score_logs (
        user_id,
        gallery_id,
        puzzle_id,
        delta,
        new_total,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      `,
      [userId, galleryId, puzzleId, POINTS, newScore]
    );

    await client.query("COMMIT");

    res.json({
      status: "SUCCESS",
      totalScore: newScore,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ATTEMPT PUZZLE ERROR:", err);

    res.status(500).json({
      error: "Internal error",
    });
  } finally {
    client.release();
  }
});

app.post("/track-event", async (req, res) => {
  try {
    const {
      eventType,
      userId,
      userName,
      galleryId,
      puzzleId,
      sessionId,
    } = req.body || {};

    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
      return res.status(400).json({
        error: `Invalid or missing eventType. Must be one of: ${[
          ...VALID_EVENT_TYPES,
        ].join(", ")}`,
      });
    }

    if (!userId) {
      return res.status(400).json({
        error: "Missing userId",
      });
    }

    const eventId = crypto.randomUUID();

    await pool.query(
      `
      INSERT INTO analytics_events (
        event_id,
        event_type,
        user_id,
        user_name,
        gallery_id,
        puzzle_id,
        session_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `,
      [
        eventId,
        eventType,
        userId,
        userName || "Operator",
        galleryId || null,
        puzzleId || null,
        sessionId || null,
      ]
    );

    res.json({
      status: "OK",
      eventId,
    });
  } catch (err) {
    console.error("TRACK EVENT ERROR:", err);

    res.status(500).json({
      error: "Internal error",
    });
  }
});

app.get("/analytics/events", async (req, res) => {
  try {
    const {
      eventType,
      userId,
      since,
      limit = "200",
      cursor,
    } = req.query;

    const safeLimit = Math.min(
      Math.max(parseInt(limit, 10) || 200, 1),
      1000
    );

    let values = [];
    let conditions = [];

    if (userId) {
      values.push(userId);
      conditions.push(`user_id = $${values.length}`);
    }

    if (eventType) {
      values.push(eventType);
      conditions.push(`event_type = $${values.length}`);
    }

    if (since) {
      values.push(since);
      conditions.push(`created_at >= $${values.length}::timestamptz`);
    }

    if (cursor) {
      values.push(cursor);
      conditions.push(`created_at > $${values.length}::timestamptz`);
    }

    const where =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    values.push(safeLimit + 1);

    const result = await pool.query(
      `
      SELECT
        event_id,
        event_type,
        user_id,
        user_name,
        gallery_id,
        puzzle_id,
        session_id,
        created_at
      FROM analytics_events
      ${where}
      ORDER BY created_at ASC
      LIMIT $${values.length}
      `,
      values
    );

    const hasMore = result.rows.length > safeLimit;

    const rows = hasMore
      ? result.rows.slice(0, safeLimit)
      : result.rows;

    const nextCursor =
      hasMore && rows.length
        ? rows[rows.length - 1].created_at.toISOString()
        : null;

    res.json({
      events: rows.map((row) => ({
        eventId: row.event_id,
        eventType: row.event_type,
        userId: row.user_id,
        userName: row.user_name,
        galleryId: row.gallery_id,
        puzzleId: row.puzzle_id,
        sessionId: row.session_id,
        timestamp: row.created_at,
      })),
      nextCursor,
    });
  } catch (err) {
    console.error("ANALYTICS ERROR:", err);

    res.status(500).json({
      error: "Internal error",
    });
  }
});

app.listen(PORT, async () => {
  console.log(`QR Puzzle API running on port ${PORT}`);

  try {
    await pool.query("SELECT NOW()");
    console.log("PostgreSQL connected successfully");
  } catch (err) {
    console.error("PostgreSQL connection failed:", err);
  }
});