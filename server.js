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
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ---------------------------------------------------------------
// Stripe webhook — MUST be registered before express.json() below,
// because Stripe's signature verification needs the exact raw request
// body, not a body that's already been parsed into an object.
// ---------------------------------------------------------------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Stripe webhook received but Stripe is not configured on this server.');
    return res.status(500).send('Stripe not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const classId = session.metadata && session.metadata.classId;
      if (classId && session.customer && session.subscription) {
        await db.activateSubscriptionForClassId({
          classId,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          status: 'active',
          planId: session.metadata && session.metadata.planId,
        });
        // A genuine conversion — tied to Stripe actually confirming payment
        // setup, not just a click on a button. Failure here should never
        // break the real activation above, so it's isolated in its own try.
        try { await db.logAnalyticsEvent({ eventType: 'converted', page: null }); } catch (e) { console.error('Analytics log failed:', e); }
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      // Stripe subscription statuses: active, past_due, canceled, unpaid, trialing, incomplete, incomplete_expired
      await db.updateSubscriptionStatusBySubscriptionId({
        stripeSubscriptionId: sub.id,
        status: sub.status,
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      });
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      if (invoice.subscription) {
        await db.updateSubscriptionStatusBySubscriptionId({ stripeSubscriptionId: invoice.subscription, status: 'past_due', cancelAtPeriodEnd: null, currentPeriodEnd: null });
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Error handling Stripe webhook:', e);
    res.status(500).send('Webhook handler error');
  }
});

app.use(express.json());

// The root domain is the public-facing marketing/signup page — that's what
// a parent lands on when they type solveitmaths.co.uk cold. The actual
// student app lives at /app instead of /, so it doesn't get shown to
// someone who hasn't signed up yet and has no idea what a class code is.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// One student per subscription now — a parent with more than one child signs
// up again for each. This constant exists so the cap is defined in exactly
// one place rather than hardcoded inline, in case that model ever changes.
const PARENT_STUDENT_LIMIT = parseInt(process.env.PARENT_STUDENT_LIMIT || '1', 10);

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
// Parent signup: create a pending "account of one student", start Stripe Checkout
// ---------------------------------------------------------------
app.post('/api/signup/start', async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: 'Payments are not configured on this server yet.' });
    }
    const { email, passcode, accountName } = req.body || {};
    if (!email || !passcode) return res.status(400).json({ error: 'email and passcode are required' });
    if (String(passcode).length < 4) return res.status(400).json({ error: 'Passcode should be at least 4 characters' });

    const passcodeHash = await bcrypt.hash(String(passcode), 10);
    let classCode, created;
    for (let attempt = 0; attempt < 5; attempt++) {
      classCode = randomClassCode();
      try {
        created = await db.createPendingParentAccount({
          classCode, ownerEmail: email, passcodeHash,
          className: accountName || (email.split('@')[0] + "'s account"),
        });
        break;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }

    const trialDays = parseInt(process.env.TRIAL_DAYS || '7', 10);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: trialDays > 0 ? { trial_period_days: trialDays } : undefined,
      metadata: { classId: String(created.id), planId: process.env.STRIPE_PRICE_ID },
      // Overrides the checkout page's displayed name for just this session,
      // rather than the account's shared business name (which would also
      // affect the other product on this same Stripe account).
      branding_settings: { display_name: 'Solve It Maths' },
      success_url: `${process.env.PUBLIC_BASE_URL}/signup.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_BASE_URL}/signup.html?cancelled=1`,
    });
    try { await db.logAnalyticsEvent({ eventType: 'checkout_started', page: null }); } catch (e) { console.error('Analytics log failed:', e); }
    res.json({ checkoutUrl: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// ---------------------------------------------------------------
// Analytics — deliberately minimal. No cookies, no visitor ID, nothing that
// identifies a person. Just anonymous counts, so we can see a conversion
// funnel (page view -> checkout started -> converted) without tracking
// individuals — never added to the student-facing app, only the marketing
// pages that adults (parents) visit before signing up.
// ---------------------------------------------------------------
app.post('/api/analytics/pageview', async (req, res) => {
  try {
    const { page } = req.body || {};
    await db.logAnalyticsEvent({ eventType: 'page_view', page: page ? String(page).slice(0, 60) : null });
    res.json({ ok: true });
  } catch (e) {
    console.error('Analytics log failed:', e);
    res.json({ ok: false }); // never break the page over a logging failure
  }
});
app.get('/api/analytics/summary', async (req, res) => {
  const key = req.query.key;
  if (!process.env.ANALYTICS_SECRET || key !== process.env.ANALYTICS_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing key' });
  }
  try {
    const summary = await db.getAnalyticsSummary();
    res.json(summary);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load analytics' });
  }
});

// ---------------------------------------------------------------
// After Stripe redirects back: confirm payment and hand back the class code.
// This gives the success page an immediate answer rather than waiting on
// webhook timing, while the webhook above remains the source of truth for
// ongoing subscription status (renewals, cancellations, failed payments).
// ---------------------------------------------------------------
app.get('/api/signup/confirm', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Payments are not configured on this server yet.' });
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(402).json({ error: 'Payment not completed yet' });
    }
    const classId = session.metadata && session.metadata.classId;
    if (!classId) return res.status(400).json({ error: 'Could not find the associated account' });

    const klass = await db.getClassById(classId);
    if (!klass) return res.status(404).json({ error: 'Account not found' });

    // Check the REAL subscription state — both so the belt-and-braces fallback
    // below records the correct status rather than guessing, and so the
    // frontend can say something accurate ("payment confirmed" is simply
    // false during a free trial, since Stripe hasn't actually charged
    // anything yet).
    let isTrialing = false, trialEnd = null, realStatus = 'active';
    if (session.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        realStatus = subscription.status;
        isTrialing = subscription.status === 'trialing';
        trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
      } catch (e) {
        console.error('Could not retrieve subscription for trial status:', e);
        // Not fatal — worst case we fall back to 'active' below and the
        // frontend uses its generic (still-correct-enough) message.
      }
    }

    // Belt-and-braces: make sure this account is marked with its real status
    // even if the webhook hasn't landed yet (webhooks can arrive a second or
    // two late) — using the real status here, not just hardcoding 'active',
    // so a trialing subscription doesn't get mislabelled as fully active.
    if (klass.subscription_status !== realStatus && session.customer) {
      await db.activateSubscriptionForClassId({
        classId,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        status: realStatus,
        planId: process.env.STRIPE_PRICE_ID,
      });
    }

    res.json({ classCode: klass.class_code, className: klass.class_name, isTrialing, trialEnd });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not confirm your payment — please contact support with your email.' });
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
    res.json({
      className: klass.class_name, classCode: klass.class_code,
      ownerType: klass.owner_type,
      hasSubscription: !!klass.stripe_subscription_id,
      subscriptionStatus: klass.subscription_status,
      cancelAtPeriodEnd: klass.cancel_at_period_end,
      currentPeriodEnd: klass.current_period_end,
      ...summary,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load class data' });
  }
});

// Parent self-serve subscription management. `cancel: true` schedules
// cancellation for the end of the current period (matches the Terms of
// Service: "you'll keep access until the end of the period you've already
// paid for"); `cancel: false` undoes a scheduled cancellation, in case
// someone changes their mind before the period actually ends.
app.post('/api/teacher/subscription', async (req, res) => {
  const token = req.headers['x-teacher-token'];
  if (!token) return res.status(401).json({ error: 'Missing teacher token' });
  const klass = await verifyTeacherToken(token);
  if (!klass) return res.status(401).json({ error: 'Invalid or expired teacher session' });
  if (klass.owner_type !== 'parent' || !klass.stripe_subscription_id) {
    return res.status(400).json({ error: 'This class has no subscription to manage.' });
  }
  if (!stripe) return res.status(500).json({ error: 'Billing is not configured on this server yet.' });
  const { cancel } = req.body || {};
  if (typeof cancel !== 'boolean') return res.status(400).json({ error: 'Missing cancel (true/false) in request body.' });
  try {
    const updated = await stripe.subscriptions.update(klass.stripe_subscription_id, { cancel_at_period_end: cancel });
    await db.setCancelAtPeriodEnd({
      classId: klass.id,
      cancelAtPeriodEnd: !!updated.cancel_at_period_end,
      currentPeriodEnd: updated.current_period_end ? new Date(updated.current_period_end * 1000) : null,
    });
    res.json({ cancelAtPeriodEnd: !!updated.cancel_at_period_end, currentPeriodEnd: updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null });
  } catch (e) {
    console.error('Failed to update subscription:', e);
    res.status(500).json({ error: 'Could not update your subscription — please try again or contact us.' });
  }
});

// ---------------------------------------------------------------
// Student: join a class with a class code + first name
// ---------------------------------------------------------------
// A subscription grants access while it's 'active' OR 'trialing' — both mean
// "this person is paying, or genuinely about to." Anything else (past_due,
// canceled, unpaid, incomplete...) does not. Used everywhere access is
// gated, so there's exactly one place that defines "does this count".
function subscriptionGrantsAccess(status) {
  return status === 'active' || status === 'trialing';
}

app.post('/api/join', async (req, res) => {
  try {
    const { classCode, studentName } = req.body || {};
    if (!classCode || !studentName) return res.status(400).json({ error: 'classCode and studentName are required' });
    const klass = await db.getClassByCode(String(classCode).toUpperCase());
    if (!klass) return res.status(404).json({ error: 'No class found with that code — check it with your teacher' });
    if (klass.owner_type === 'parent' && !subscriptionGrantsAccess(klass.subscription_status)) {
      return res.status(402).json({ error: 'This subscription isn\'t active — please check your payment details or contact support.' });
    }

    const cleanName = String(studentName).trim().slice(0, 40);
    if (!cleanName) return res.status(400).json({ error: 'Enter your name' });

    let student = await db.getStudentByNameInClass(klass.id, cleanName);
    if (!student) {
      // One subscription = one student now. A parent with more than one
      // child needs a separate subscription (and separate login) for each —
      // there's no shared "family code" any more, since that's exactly what
      // was liable to get shared beyond the people it was meant for.
      if (klass.owner_type === 'parent') {
        const existing = await db.getStudentsInClass(klass.id);
        if (existing.length >= PARENT_STUDENT_LIMIT) {
          return res.status(403).json({ error: 'This subscription is for one student. If you have another child, they\'ll need their own separate subscription.' });
        }
      }
      student = await db.createStudent({ classId: klass.id, name: cleanName, token: randomToken() });
    }
    res.json({ studentToken: student.token, studentName: student.name, className: klass.class_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not join class' });
  }
});

// Verifies a student token AND that their subscription (if a parent account,
// not a free teacher class) is still active — this is what stops a lapsed
// or cancelled subscriber from continuing to use a paid account for free.
async function verifyStudent(req) {
  const token = req.headers['x-student-token'];
  if (!token) return null;
  const student = await db.getStudentByToken(token);
  if (!student) return null;
  const klass = await db.getClassById(student.class_id);
  if (!klass) return null;
  if (klass.owner_type === 'parent' && !subscriptionGrantsAccess(klass.subscription_status)) return null;
  return student;
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

// ---------------------------------------------------------------
// Tutor safety net: a deliberately simple, honest-about-its-limits
// keyword backstop. It will not catch everything a careful safeguarding
// lead would — it's not a clinical detection tool — but it means a
// clear disclosure doesn't just vanish into an unread chat log. Matches
// get logged for a teacher/parent to see; the student's conversation
// continues normally either way, since blocking it would help no one.
// ---------------------------------------------------------------
const CONCERN_PATTERNS = [
  { re: /\b(kill myself|end my life|end it all|don'?t want to be alive|suicidal|no reason to live)\b/i, category: 'possible self-harm risk' },
  { re: /\b(self.?harm|hurt(ing)? myself|cutting myself|harming myself)\b/i, category: 'possible self-harm risk' },
  { re: /\b(mum|mom|dad|mother|father|step ?dad|step ?mom|step ?mum|brother|sister|uncle|aunt|boyfriend|girlfriend|he|she|they|someone) (hits?|hurts?|abuses?|touches?) me\b/i, category: 'possible abuse disclosure' },
  { re: /\b(being abused|being hurt at home|not safe at home|scared to go home)\b/i, category: 'possible abuse disclosure' },
  { re: /\b(no ?one|nobody) (cares|would notice|would miss me)\b/i, category: 'possible distress' },
];
function detectConcern(text){
  if (!text) return null;
  for (const p of CONCERN_PATTERNS) { if (p.re.test(text)) return p.category; }
  return null;
}

app.post('/api/tutor', async (req, res) => {
  const student = await verifyStudent(req);
  if (!student) return res.status(401).json({ error: 'Not logged in' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Tutor is not configured on this server yet (missing ANTHROPIC_API_KEY).' });
  if (isRateLimited(student.id)) return res.status(429).json({ error: 'Slow down a little — try again in a minute.' });

  try {
    const { topicName, levelLabel, questionPrompt, questionText, correctAnswer, workedSteps, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'No message provided' });

    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === 'user') {
      const category = detectConcern(String(lastUserMsg.content || ''));
      if (category) {
        try { await db.logFlaggedMessage({ studentId: student.id, messageText: lastUserMsg.content, category }); }
        catch (e) { console.error('Failed to log flagged message:', e); }
      }
    }

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
      "The student is a school-age child — keep everything age-appropriate and stay strictly on the maths question. " +
      "IMPORTANT SAFETY INSTRUCTION: if anything the student writes suggests they are distressed, unsafe, being harmed, or " +
      "having thoughts of harming themselves — even briefly, even if they then move on to a maths question — do not ignore it " +
      "and do not attempt to counsel them yourself. Respond with brief warmth (1-2 sentences), gently encourage them to tell a " +
      "trusted adult (a parent, teacher, or another adult they trust) what's going on, and mention that Childline (0800 1111, " +
      "childline.org.uk) is free and confidential if they'd rather talk to someone outside their family right now. Then stop " +
      "there for that message — do not continue with the maths question in the same reply.";

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
