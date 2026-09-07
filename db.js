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
  return { students, progress: progressRes.rows, recent: recentRes.rows };
}

module.exports = {
  pool, init,
  createClass, getClassByCode,
  createStudent, getStudentByNameInClass, getStudentByToken, getStudentsInClass,
  getProgressForStudent, upsertProgress, resetProgressForStudent, logAttempt,
  getClassSummary,
};
