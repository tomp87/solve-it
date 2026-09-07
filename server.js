// server.js — the whole backend API.
//
// Auth model is deliberately lightweight, on purpose:
//   - Students never set a password or give an email — just a class code
//     (from their teacher) and their first name. This keeps the data we
//     collect from minors to an absolute minimum, which matters both
//     ethically and for UK data-protection compliance (see README).
//   - Teachers set a passcode when creating a class, used only to view
//     the dashboard for that class.
//   - Session tokens are random UUIDs, not JWTs — there's nothing
//     sensitive enough here to need more than "hard to guess by accident".

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}
function randomClassCode() {
  // Six characters, uppercase, no ambiguous 0/O/1/I — easy for a class to read off a whiteboard.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

// ---------------------------------------------------------------
// Teacher: create a class
// ---------------------------------------------------------------
app.post('/api/teacher/create-class', async (req, res) => {
  try {
    const { teacherName, className, passcode } = req.body || {};
    if (!teacherName || !className || !passcode) {
      return res.status(400).json({ error: 'teacherName, className, and passcode are all required' });
    }
    if (String(passcode).length < 4) {
      return res.status(400).json({ error: 'Passcode should be at least 4 characters' });
    }
    const passcodeHash = await bcrypt.hash(String(passcode), 10);
    let classCode, created;
    // Retry on the (very unlikely) chance of a class-code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      classCode = randomClassCode();
      try {
        created = await db.createClass({ classCode, teacherName, className, passcodeHash });
        break;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
    res.json({ classCode: created.class_code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create class' });
  }
});

// ---------------------------------------------------------------
// Teacher: log in to view a class dashboard
// ---------------------------------------------------------------
app.post('/api/teacher/login', async (req, res) => {
  try {
    const { classCode, passcode } = req.body || {};
    if (!classCode || !passcode) return res.status(400).json({ error: 'classCode and passcode are required' });
    const klass = await db.getClassByCode(String(classCode).toUpperCase());
    if (!klass) return res.status(404).json({ error: 'No class found with that code' });
    const ok = await bcrypt.compare(String(passcode), klass.passcode_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect passcode' });
    res.json({ teacherToken: Buffer.from(`${klass.id}:${klass.passcode_hash}`).toString('base64') });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verifies the teacherToken issued above and returns the class row, or null.
async function verifyTeacherToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [classId, hashFromToken] = decoded.split(':');
    const res = await db.pool.query('SELECT * FROM classes WHERE id = $1', [classId]);
    const klass = res.rows[0];
    if (!klass || klass.passcode_hash !== hashFromToken) return null;
    return klass;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------
// Teacher: dashboard data for a class
// ---------------------------------------------------------------
app.get('/api/teacher/class', async (req, res) => {
  const token = req.headers['x-teacher-token'];
  if (!token) return res.status(401).json({ error: 'Missing teacher token' });
  const klass = await verifyTeacherToken(token);
  if (!klass) return res.status(401).json({ error: 'Invalid or expired teacher session' });
  try {
    const summary = await db.getClassSummary(klass.id);
    res.json({ className: klass.class_name, classCode: klass.class_code, ...summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load class data' });
  }
});

// ---------------------------------------------------------------
// Student: join a class with a class code + first name
// ---------------------------------------------------------------
app.post('/api/join', async (req, res) => {
  try {
    const { classCode, studentName } = req.body || {};
    if (!classCode || !studentName) return res.status(400).json({ error: 'classCode and studentName are required' });
    const klass = await db.getClassByCode(String(classCode).toUpperCase());
    if (!klass) return res.status(404).json({ error: 'No class found with that code — check it with your teacher' });

    const cleanName = String(studentName).trim().slice(0, 40);
    if (!cleanName) return res.status(400).json({ error: 'Enter your name' });

    let student = await db.getStudentByNameInClass(klass.id, cleanName);
    if (!student) {
      student = await db.createStudent({ classId: klass.id, name: cleanName, token: randomToken() });
    }
    res.json({ studentToken: student.token, studentName: student.name, className: klass.class_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not join class' });
  }
});

// Verifies a student token from the Authorization header, or null.
async function verifyStudent(req) {
  const token = req.headers['x-student-token'];
  if (!token) return null;
  return db.getStudentByToken(token);
}

// ---------------------------------------------------------------
// Student: fetch their own progress (all topics)
// ---------------------------------------------------------------
app.get('/api/progress', async (req, res) => {
  const student = await verifyStudent(req);
  if (!student) return res.status(401).json({ error: 'Not logged in' });
  try {
    const rows = await db.getProgressForStudent(student.id);
    const byTopic = {};
    rows.forEach(r => {
      byTopic[r.topic_id] = {
        attempted: r.attempted, correct: r.correct,
        bestStreak: r.best_streak, currentStreak: r.current_streak,
        last: r.last_results,
      };
    });
    res.json({ progress: byTopic });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load progress' });
  }
});

// ---------------------------------------------------------------
// Student: save progress after marking a question
// ---------------------------------------------------------------
app.post('/api/progress', async (req, res) => {
  const student = await verifyStudent(req);
  if (!student) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { topicId, levelId, wasCorrect, attempted, correct, bestStreak, currentStreak, last } = req.body || {};
    if (!topicId || typeof wasCorrect !== 'boolean') return res.status(400).json({ error: 'Missing fields' });
    await db.upsertProgress({
      studentId: student.id, topicId,
      attempted: attempted | 0, correct: correct | 0,
      bestStreak: bestStreak | 0, currentStreak: currentStreak | 0,
      lastResults: Array.isArray(last) ? last.slice(-8) : [],
    });
    await db.logAttempt({ studentId: student.id, topicId, levelId: levelId || null, wasCorrect });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save progress' });
  }
});

// ---------------------------------------------------------------
// Student: reset their own progress
// ---------------------------------------------------------------
app.post('/api/progress/reset', async (req, res) => {
  const student = await verifyStudent(req);
  if (!student) return res.status(401).json({ error: 'Not logged in' });
  try {
    await db.resetProgressForStudent(student.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not reset progress' });
  }
});

// ---------------------------------------------------------------
// Tutor chat — proxied server-side so the Anthropic API key is never
// exposed to the browser, and so we can rate-limit / moderate later.
// ---------------------------------------------------------------
const tutorRateLimit = new Map(); // studentId -> [timestamps]
function isRateLimited(studentId) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxPerWindow = 8; // generous for genuine back-and-forth, tight enough to block runaway loops/abuse
  const timestamps = (tutorRateLimit.get(studentId) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  tutorRateLimit.set(studentId, timestamps);
  return timestamps.length > maxPerWindow;
}

app.post('/api/tutor', async (req, res) => {
  const student = await verifyStudent(req);
  if (!student) return res.status(401).json({ error: 'Not logged in' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Tutor is not configured on this server yet (missing ANTHROPIC_API_KEY).' });
  if (isRateLimited(student.id)) return res.status(429).json({ error: 'Slow down a little — try again in a minute.' });

  try {
    const { topicName, levelLabel, questionPrompt, questionText, correctAnswer, workedSteps, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'No message provided' });

    const systemPrompt =
      "You are a warm, patient GCSE Maths tutor helping a student with the practice question below. " +
      "Topic: " + (topicName || '') + " (" + (levelLabel || '') + "). " +
      "Question: " + (questionPrompt || '') + ": " + String(questionText || '').replace(/\n/g, ' / ') + ". " +
      "The correct final answer is: " + (correctAnswer || '') + ". " +
      "Reference worked solution, for your own grounding — do not just paste this verbatim: " + (Array.isArray(workedSteps) ? workedSteps.join(' | ') : '') + ". " +
      "Guidance: use small guiding questions or hints first rather than immediately giving the full answer. " +
      "Only give the complete final answer if the student explicitly asks for it, or seems stuck after a couple of exchanges. " +
      "Keep replies short — 2 to 4 sentences — encouraging, and use UK GCSE-appropriate language and notation. " +
      "Do not introduce different numbers or a different method than the ones given above. " +
      "The student is a school-age child — keep everything age-appropriate and stay strictly on the maths question.";

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: messages.slice(-10), // cap history sent per call
      }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) {
      console.error('Anthropic API error', data);
      return res.status(502).json({ error: 'The tutor is having trouble responding right now.' });
    }
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || "Sorry, I couldn't come up with a reply there — try asking again.";
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The tutor is having trouble responding right now.' });
  }
});

app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Solve It backend running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });

module.exports = app;
