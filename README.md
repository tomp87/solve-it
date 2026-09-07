# Solve It — backend

This turns the "Solve It" prototype into a real, deployable app: class accounts
for students (no passwords, no email — just a class code and a first name),
progress that's saved on a real server instead of one browser, a teacher
dashboard, and an AI tutor that runs through your own server instead of
calling Claude directly from the browser.

This README assumes you've never deployed a Node app before. It'll take
maybe 30–45 minutes the first time, almost all of it just creating free
accounts and clicking through their setup wizards.

## What you'll need (all free to start)

1. A **Supabase** account — this hosts the actual database (supabase.com)
2. A **Render** account — this hosts the running app (render.com). Railway or
   Fly.io work just as well if you prefer either of those.
3. An **Anthropic API key** — this powers the "Ask for help" tutor
   (console.anthropic.com). This is separate from a claude.ai subscription —
   it's pay-per-use, and you'll need to add a card, but usage for a single
   class's worth of hint requests should be very cheap (a few pence to a few
   pounds a month, not more, unless usage is very heavy — keep an eye on it
   for the first couple of weeks of a pilot).

You don't strictly need step 3 to launch — everything except the tutor chat
works fine without an Anthropic key. You can add it later.

## Step 1 — Create the database (Supabase)

1. Go to supabase.com, sign up, and create a new project (pick any name/region).
2. Once it's created: **Project Settings → Database → Connection string → URI**.
   Copy that connection string — it looks like
   `postgres://postgres:[password]@db.xxxx.supabase.co:5432/postgres`.
3. That's it — you don't need to create any tables by hand. The app creates
   its own tables automatically the first time it starts up (see `db.js`).

## Step 2 — Get an Anthropic API key (optional but recommended)

1. Go to console.anthropic.com, sign up, add a payment method.
2. **Settings → API Keys → Create key**. Copy it (starts with `sk-ant-`).

## Step 3 — Deploy the app (Render)

1. Put this project in a GitHub repository (create a new repo, upload these
   files — or ask me and I can talk you through `git init` / `git push` if
   you're not familiar with Git).
2. On render.com: **New → Web Service**, connect your GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine to start.
4. Under **Environment**, add these variables:
   - `DATABASE_URL` — the Supabase connection string from Step 1
   - `ANTHROPIC_API_KEY` — the key from Step 2 (skip if not using the tutor yet)
5. Click **Create Web Service**. Render will install dependencies and start
   the app — the first deploy takes a few minutes. When it's done you'll get
   a URL like `https://solve-it-yourschool.onrender.com`.

That URL is now a real, live app. `/` is the student app, `/teacher` is the
teacher dashboard.

**One free-tier quirk worth knowing:** Render's free web services "sleep"
after 15 minutes of no traffic and take ~30–60 seconds to wake back up on
the next request. Fine for a low-key pilot; annoying if you want it instantly
responsive in a live lesson. Paid tiers (from ~$7/month) remove this.

## Step 4 — Set up your first class

1. Visit `https://your-app-url.onrender.com/teacher`.
2. Click "Create a new class", fill in your name, a class name, and a
   passcode you'll remember.
3. You'll get a 6-character class code. Write it on the board / share it
   with students.
4. Students go to `https://your-app-url.onrender.com/`, enter the class code
   and their first name, and they're in — no account creation, no email.

## Running it locally first (recommended before deploying)

```
npm install
cp .env.example .env
# edit .env — paste in your real DATABASE_URL (and ANTHROPIC_API_KEY if you have one)
npm start
```

Then open `http://localhost:3000` in your browser. This talks to the real
Supabase database, so it's a genuine test, not a simulation — good for
checking everything works before you put it in front of students.

## What's deliberately NOT here yet

This is a pilot-ready MVP, not a finished commercial product. Notably
missing, on purpose, to keep this build focused:

- **No password reset / email verification** — there are no passwords or
  emails at all for students, which is intentional (see "On student data"
  below), but it does mean there's no way to prove a given browser session
  really is who it claims to be beyond "knows the class code and typed a
  name". Fine for a classroom pilot; not something I'd want scaled to
  strangers on the internet without more thought.
- **No teacher account recovery** — if a teacher forgets their passcode,
  there's currently no "forgot passcode" flow. Given the current DB access,
  the practical fix is: someone with database access resets `passcode_hash`
  directly, or you delete and recreate the class. Worth building a proper
  reset flow before this goes beyond your own use.
- **No data export** — a teacher can't currently download their class's
  results as a spreadsheet. Easy to add; just not built yet.
- **No rate limiting beyond the tutor chat** — the tutor endpoint has basic
  per-student rate limiting built in; the rest of the API doesn't yet, which
  is normally fine for a small pilot but would want hardening before wider use.

## On student data, briefly

This app collects the absolute minimum from students on purpose: a
first name (which a student can type as anything — it's an identifier for
their own progress tracking, not verified identity) and their question
history. No email, no password, no other personal data.

That said, if you plan to use this beyond your own classroom — especially
if other schools or the general public would sign up directly rather than
through a school — please get a proper legal/data-protection opinion before
launching. The relevant starting point in the UK is the ICO's Children's
Code (also called the Age Appropriate Design Code); whether and how it
applies depends specifically on how the app is distributed (procured by a
school vs. direct-to-consumer), which is exactly the kind of nuance worth
paying a solicitor an hour of their time to get right rather than guessing.
I'm not a lawyer and this isn't legal advice — just a pointer to the right
starting question to ask one.

## Project structure

```
server.js          — the whole API (auth, progress, tutor proxy)
db.js               — database schema + queries (Postgres)
public/index.html   — the student app (question engine + login + practice UI)
public/teacher.html — the teacher dashboard
package.json        — dependencies
.env.example        — template for required environment variables
```

## If something breaks

Check the Render logs (**Dashboard → your service → Logs**) first — most
issues at this stage will be either a missing/wrong `DATABASE_URL`, or the
Anthropic key missing if the tutor chat isn't responding. Both show up
clearly in the server logs with a descriptive error, not a silent failure.
