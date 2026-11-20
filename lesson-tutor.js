// lesson-tutor.js: video lessons with an AI tutor that knows what's on screen.
//
// Wire it up in server.js (after express.json() and the existing helpers exist):
//
//   const mountLessons = require('./lesson-tutor');
//   mountLessons(app, {
//     getStudent:   async (req) => ...,  // the logged-in student for this request, or null (reuse verifyStudent)
//     hasAccess:    async (student) => ..., // true if they can use the tutor (reuse subscriptionGrantsAccess / teacher-class rule)
//     rateLimitOk:  (student) => ...,      // reuse the existing 8-per-minute limiter; return false when over
//     onConcern:    async (student, text) => ..., // reuse detectConcern + the flagged_messages insert; return true if flagged
//     safetyText:   SAFETY_INSTRUCTION,    // the existing "IMPORTANT SAFETY INSTRUCTION: ..." paragraph, unchanged
//   });
//
// Lessons are JSON files in ./lessons (made with "⬇ Lesson file for site" in Shorts Builder).
// Routes added:
//   GET  /lesson/:id            -> public/lesson.html (the page reads the id from the URL)
//   GET  /api/lessons           -> list of lessons (id, title, topic, youtubeId, duration)
//   GET  /api/lessons/:id       -> one lesson (chapters + timed beats)
//   POST /api/tutor-lesson      -> { lessonId, t, messages:[{role,content}] }  =>  { reply }

const fs = require('fs');
const path = require('path');

const LESSON_DIRS = [path.join(__dirname, 'lessons'), path.join(__dirname, 'public', 'lessons')]; // either location works
const MODEL = process.env.LESSON_TUTOR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 600;

let cache = { at: 0, lessons: new Map() };
function loadLessons() {
  if (Date.now() - cache.at < 60_000 && cache.lessons.size) return cache.lessons;
  const lessons = new Map();
  for (const dir of LESSON_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) { /* folder not there */ }
    for (const f of files) {
      try {
        const L = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (L && L.id && Array.isArray(L.beats) && !lessons.has(L.id)) lessons.set(L.id, L);
      } catch (e) { console.error('[lessons] bad file', f, e.message); }
    }
  }
  cache = { at: Date.now(), lessons };
  return lessons;
}

const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

function beatAt(L, t) {
  let i = L.beats.findIndex(b => t < b.end);
  if (i < 0) i = L.beats.length - 1;
  return i;
}

function buildSystemPrompt(L, t, safetyText) {
  const i = beatAt(L, t);
  const cur = L.beats[i];
  const keys = L.beats.filter(b => b.key).map(b => `- ${b.chapter}: ${b.key}`);
  const chapters = (L.chapters || []).map(c => `- ${mmss(c.start)} ${c.name} [[jump:${Math.floor(c.start)}]]`);
  const near = L.beats.slice(Math.max(0, i - 2), Math.min(L.beats.length, i + 2)).map((b, k) => {
    const idx = L.beats.indexOf(b);
    const tag = idx === i ? '  <-- PAUSED HERE' : idx < i ? '  (just before)' : '  (comes next, not seen yet)';
    return `[${mmss(b.start)}–${mmss(b.end)}] ${b.title}${tag}\n  Narration: "${b.says}"\n  On screen: ${b.onScreen}` + (b.key ? `\n  Key rule: ${b.key}` : '');
  });
  // If they paused on a practice question before the answer was shown, don't spoil it.
  const onQuestion = cur.pauseForStudent || (cur.question && !cur.answer);
  const qNote = onQuestion
    ? `\nThe student has paused on a "your turn" practice question. Do NOT give the final answer unless they explicitly ask for it; guide them with hints, one step at a time.`
    : '';

  return `You are a warm, patient GCSE Maths tutor sitting next to a student while they watch a Solve It video lesson.
Lesson: "${L.title}" (topic: ${L.topic}). The student paused the video at ${mmss(t)}.

What the video says and shows around that moment:
${near.join('\n')}

The method this lesson teaches:
${keys.length ? keys.join('\n') : '- (see the narration above)'}

Chapters (use the [[jump:SECONDS]] tag exactly as shown if you suggest rewatching a part; the page turns it into a button):
${chapters.join('\n')}
${qNote}
HOW TO TEACH:
1. Start with the video's own method, using the same steps, words and numbers the video uses at this point, so your help matches what they just watched. Answer the actual question they asked about this moment.
2. If they say they still don't get it (or the same confusion comes back), do not repeat the same explanation in different words. Switch to a genuinely different approach and say so briefly ("Let's look at it another way."). Good alternatives: a picture described in words, a simple number example with small numbers, an everyday comparison, building it up from something they already know, a different valid method, or checking the answer backwards.
3. Keep track of what you've already tried in this chat and pick something new each time. After two different approaches, ask which part exactly is confusing before trying a third.
4. Any correct GCSE method is fine when it helps, but say how it connects back to the video's method so the student isn't left with two disconnected ideas.
5. Keep each reply short: 2 to 5 sentences, one idea at a time, ending with a quick check question when it helps. Encouraging, never patronising. UK GCSE language and notation.
6. Write maths as plain text with Unicode symbols (π, ², ³, √, ×, ÷, −, ½). Never use LaTeX, dollar signs or markdown.
7. If they ask about something the video covers later, tell them briefly and offer the [[jump:SECONDS]] for that chapter. If they ask about something off-topic but still maths, help briefly. Stay on maths.
8. The student is a school-age child: keep everything age-appropriate.

${safetyText || ''}`.trim();
}

module.exports = function mountLessons(app, deps = {}) {
  const getStudent = deps.getStudent || (async () => null);
  const hasAccess = deps.hasAccess || (async () => false);
  const rateLimitOk = deps.rateLimitOk || (() => true);
  const onConcern = deps.onConcern || (async () => false);
  const safetyText = deps.safetyText || '';
  const callModel = deps.callModel || (async ({ system, messages }) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
    });
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  });

  app.get('/lessons', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lessons.html')));
  app.get('/lesson/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lesson.html')));

  // Visit /api/lessons?debug=1 to see where the server is looking and why a file was skipped.
  app.get('/api/lessons', (req, res) => {
    if (req.query.debug) {
      const report = LESSON_DIRS.map(dir => {
        let files = null, err = null;
        try { files = fs.readdirSync(dir); } catch (e) { err = e.code || e.message; }
        const checks = (files || []).filter(f => f.endsWith('.json')).map(f => {
          try { const L = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { file: f, id: L.id || null, hasBeatsArray: Array.isArray(L.beats) }; }
          catch (e) { return { file: f, error: e.message }; }
        });
        return { dir, folderError: err, files, checks };
      });
      return res.json({ cwd: process.cwd(), dirname: __dirname, report });
    }
    const list = [...loadLessons().values()].map(L => ({ id: L.id, title: L.title, topic: L.topic, youtubeId: L.youtubeId, duration: L.duration }));
    res.json({ lessons: list });
  });

  app.get('/api/lessons/:id', (req, res) => {
    const L = loadLessons().get(String(req.params.id));
    if (!L) return res.status(404).json({ error: 'Lesson not found' });
    res.json(L);
  });

  app.post('/api/tutor-lesson', async (req, res) => {
    try {
      const student = await getStudent(req);
      if (!student) return res.status(401).json({ error: 'login', reply: 'Log in with your class code to ask the tutor.' });
      if (!(await hasAccess(student))) return res.status(402).json({ error: 'subscription', reply: 'The tutor is part of a Solve It subscription. Start the free 7-day trial to use it.' });
      if (!rateLimitOk(student)) return res.status(429).json({ error: 'rate', reply: 'Give me a few seconds to catch up, then ask again.' });

      const { lessonId, t } = req.body || {};
      const L = loadLessons().get(String(lessonId || ''));
      if (!L) return res.status(404).json({ error: 'Lesson not found' });
      const time = Math.max(0, Math.min(Number(t) || 0, L.duration || 1e9));

      let messages = Array.isArray(req.body.messages) ? req.body.messages : [];
      messages = messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }))
        .slice(-12);
      while (messages.length && messages[0].role !== 'user') messages.shift();
      if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'No question' });

      const last = messages[messages.length - 1].content;
      await onConcern(student, last, { lessonId: L.id, t: time });

      const system = buildSystemPrompt(L, time, safetyText);
      const reply = await callModel({ system, messages });
      res.json({ reply });
    } catch (e) {
      console.error('[tutor-lesson]', e.message);
      res.status(500).json({ error: 'server', reply: 'Sorry, I couldn’t answer just then. Try again in a moment.' });
    }
  });
};

module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.loadLessons = loadLessons;
