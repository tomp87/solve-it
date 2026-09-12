// db.js — Postgres access layer.
//
// Designed to work against Supabase's free Postgres tier (or any Postgres),
// so student/teacher data survives restarts and redeploys — unlike a local
// SQLite file on a host with an ephemeral filesystem, which would silently
// lose everything on the next deploy.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }, // Supabase requires SSL; this is the standard way to connect from Node without needing their CA bundle.
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      class_code TEXT UNIQUE NOT NULL,
      teacher_name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      passcode_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // These ALTERs run every startup but are no-ops once applied — this is what
  // lets us evolve the schema (adding paid-subscription support) without a
  // separate migration step, and without disturbing the classes/students
  // already live in production from the school pilot.
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'teacher';`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS owner_email TEXT;`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS subscription_status TEXT;`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS plan_id TEXT;`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_classes_stripe_customer ON classes(stripe_customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_classes_stripe_subscription ON classes(stripe_subscription_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(class_id, name)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL,
      attempted INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_results JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(student_id, topic_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attempts_log (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL,
      level_id TEXT,
      was_correct BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Index used by the teacher dashboard's "recent activity" query.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attempts_student_time ON attempts_log(student_id, created_at DESC);`);

  // Safety net for the AI tutor: if a student's message matches a concerning
  // pattern (distress, self-harm, disclosure of harm), it's logged here so a
  // teacher or parent can see and follow up — the AI itself is not a substitute
  // for a trusted adult noticing this.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flagged_messages (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      message_text TEXT NOT NULL,
      category TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_flagged_student_time ON flagged_messages(student_id, created_at DESC);`);

  // Conversion analytics — deliberately minimal and anonymous. No visitor ID,
  // no cookies, nothing that could identify a specific person or be combined
  // across events to build a profile. Just "how many of X happened, on which
  // page, when" — enough to see a conversion funnel, nothing more.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      page TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_analytics_type_time ON analytics_events(event_type, created_at DESC);`);
}

// ---- Classes ----
async function createClass({ classCode, teacherName, className, passcodeHash }) {
  const res = await pool.query(
    `INSERT INTO classes (class_code, teacher_name, class_name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id, class_code`,
    [classCode, teacherName, className, passcodeHash]
  );
  return res.rows[0];
}
async function getClassByCode(classCode) {
  const res = await pool.query(`SELECT * FROM classes WHERE class_code = $1`, [classCode]);
  return res.rows[0] || null;
}
async function getClassById(id) {
  const res = await pool.query(`SELECT * FROM classes WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

// ---- Parent/subscription accounts (also rows in `classes`, owner_type='parent') ----
async function createPendingParentAccount({ classCode, ownerEmail, passcodeHash, className }) {
  const res = await pool.query(
    `INSERT INTO classes (class_code, teacher_name, class_name, passcode_hash, owner_type, owner_email, subscription_status)
     VALUES ($1,$2,$3,$4,'parent',$5,'pending')
     RETURNING id, class_code`,
    [classCode, ownerEmail, className, passcodeHash, ownerEmail]
  );
  return res.rows[0];
}
async function setStripeCheckoutSession({ classId, stripeCustomerId }) {
  await pool.query(`UPDATE classes SET stripe_customer_id = $1 WHERE id = $2`, [stripeCustomerId, classId]);
}
// Used for the FIRST activation, where we know the class only by its own id
// (from Checkout Session metadata) — the class doesn't have a stripe_customer_id
// yet, so looking it up BY stripe_customer_id (see below) would find nothing.
async function activateSubscriptionForClassId({ classId, stripeCustomerId, stripeSubscriptionId, status, planId }) {
  await pool.query(
    `UPDATE classes SET stripe_customer_id = $1, stripe_subscription_id = $2, subscription_status = $3, plan_id = $4 WHERE id = $5`,
    [stripeCustomerId, stripeSubscriptionId, status, planId || null, classId]
  );
}
// Used for ALL SUBSEQUENT events (renewals, cancellations) — by this point the
// class row already has stripe_customer_id set, so this lookup works.
async function updateSubscriptionByCustomerId({ stripeCustomerId, stripeSubscriptionId, status, planId }) {
  await pool.query(
    `UPDATE classes SET stripe_subscription_id = $1, subscription_status = $2, plan_id = $3 WHERE stripe_customer_id = $4`,
    [stripeSubscriptionId, status, planId || null, stripeCustomerId]
  );
}
async function updateSubscriptionStatusBySubscriptionId({ stripeSubscriptionId, status, cancelAtPeriodEnd, currentPeriodEnd }) {
  await pool.query(
    `UPDATE classes SET subscription_status = $1, cancel_at_period_end = COALESCE($2, cancel_at_period_end),
     current_period_end = COALESCE($3, current_period_end) WHERE stripe_subscription_id = $4`,
    [status, cancelAtPeriodEnd, currentPeriodEnd, stripeSubscriptionId]
  );
}
// Direct update for immediate dashboard feedback right after the parent clicks
// cancel/reactivate — the webhook will also confirm this shortly after, but a
// person clicking "Cancel" shouldn't have to wait for a webhook round-trip to
// see it reflected.
async function setCancelAtPeriodEnd({ classId, cancelAtPeriodEnd, currentPeriodEnd }) {
  await pool.query(
    `UPDATE classes SET cancel_at_period_end = $1, current_period_end = COALESCE($2, current_period_end) WHERE id = $3`,
    [cancelAtPeriodEnd, currentPeriodEnd, classId]
  );
}

// ---- Students ----
async function createStudent({ classId, name, token }) {
  const res = await pool.query(
    `INSERT INTO students (class_id, name, token) VALUES ($1,$2,$3) RETURNING id, name, token`,
    [classId, name, token]
  );
  return res.rows[0];
}
async function getStudentByNameInClass(classId, name) {
  const res = await pool.query(`SELECT * FROM students WHERE class_id = $1 AND name = $2`, [classId, name]);
  return res.rows[0] || null;
}
async function getStudentByToken(token) {
  const res = await pool.query(`SELECT * FROM students WHERE token = $1`, [token]);
  return res.rows[0] || null;
}
async function getStudentsInClass(classId) {
  const res = await pool.query(`SELECT id, name, created_at FROM students WHERE class_id = $1 ORDER BY name`, [classId]);
  return res.rows;
}

// ---- Progress ----
async function getProgressForStudent(studentId) {
  const res = await pool.query(`SELECT * FROM progress WHERE student_id = $1`, [studentId]);
  return res.rows;
}
async function upsertProgress({ studentId, topicId, attempted, correct, bestStreak, currentStreak, lastResults }) {
  await pool.query(
    `INSERT INTO progress (student_id, topic_id, attempted, correct, best_streak, current_streak, last_results, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (student_id, topic_id)
     DO UPDATE SET attempted = $3, correct = $4, best_streak = $5, current_streak = $6, last_results = $7, updated_at = now()`,
    [studentId, topicId, attempted, correct, bestStreak, currentStreak, JSON.stringify(lastResults)]
  );
}
async function resetProgressForStudent(studentId) {
  await pool.query(`DELETE FROM progress WHERE student_id = $1`, [studentId]);
}
async function logAttempt({ studentId, topicId, levelId, wasCorrect }) {
  await pool.query(
    `INSERT INTO attempts_log (student_id, topic_id, level_id, was_correct) VALUES ($1,$2,$3,$4)`,
    [studentId, topicId, levelId, wasCorrect]
  );
}
async function logFlaggedMessage({ studentId, messageText, category }) {
  await pool.query(
    `INSERT INTO flagged_messages (student_id, message_text, category) VALUES ($1,$2,$3)`,
    [studentId, messageText, category || null]
  );
}
async function logAnalyticsEvent({ eventType, page }) {
  await pool.query(`INSERT INTO analytics_events (event_type, page) VALUES ($1,$2)`, [eventType, page || null]);
}
async function getAnalyticsSummary() {
  const totalsRes = await pool.query(
    `SELECT event_type, page, COUNT(*) AS count FROM analytics_events GROUP BY event_type, page ORDER BY event_type, page`
  );
  const last7Res = await pool.query(
    `SELECT event_type, page, COUNT(*) AS count FROM analytics_events WHERE created_at > now() - interval '7 days' GROUP BY event_type, page ORDER BY event_type, page`
  );
  return {
    allTime: totalsRes.rows.map(r => ({ eventType: r.event_type, page: r.page, count: parseInt(r.count, 10) })),
    last7Days: last7Res.rows.map(r => ({ eventType: r.event_type, page: r.page, count: parseInt(r.count, 10) })),
  };
}

// ---- Teacher dashboard queries ----
async function getClassSummary(classId) {
  const students = await getStudentsInClass(classId);
  const progressRes = await pool.query(
    `SELECT p.* FROM progress p JOIN students s ON s.id = p.student_id WHERE s.class_id = $1`,
    [classId]
  );
  const recentRes = await pool.query(
    `SELECT s.name, a.topic_id, a.was_correct, a.created_at
     FROM attempts_log a JOIN students s ON s.id = a.student_id
     WHERE s.class_id = $1
     ORDER BY a.created_at DESC
     LIMIT 30`,
    [classId]
  );
  const flagsRes = await pool.query(
    `SELECT s.name, f.message_text, f.category, f.created_at
     FROM flagged_messages f JOIN students s ON s.id = f.student_id
     WHERE s.class_id = $1
     ORDER BY f.created_at DESC
     LIMIT 20`,
    [classId]
  );
  return { students, progress: progressRes.rows, recent: recentRes.rows, flags: flagsRes.rows };
}

module.exports = {
  pool, init,
  createClass, getClassByCode, getClassById, setCancelAtPeriodEnd,
  createPendingParentAccount, setStripeCheckoutSession, activateSubscriptionForClassId, updateSubscriptionByCustomerId, updateSubscriptionStatusBySubscriptionId,
  createStudent, getStudentByNameInClass, getStudentByToken, getStudentsInClass,
  getProgressForStudent, upsertProgress, resetProgressForStudent, logAttempt, logFlaggedMessage,
  logAnalyticsEvent, getAnalyticsSummary,
  getClassSummary,
};
