'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const websim = require('./lib/websim');
const github = require('./lib/github');
const gitOps = require('./lib/git-ops');
const tracker = require('./lib/tracker');
const { RateLimitError } = require('./lib/errors');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

// Warn on startup if session secret is using the insecure default
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET env var not set — using insecure default. Set it in your environment!');
}

// ── Security headers (no extra package needed) ──────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' })); // prevent huge payloads
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: APP_URL.startsWith('https://'),
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Input validation ────────────────────────────────────────────────────────

// GitHub logins: alphanumeric + hyphens, 1-39 chars
function isValidGhUser(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,37}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(u);
}

// WebSim/generic usernames: alphanumeric + ._- up to 100 chars
function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,98}$/.test(u.trim());
}

// ── Session helpers ─────────────────────────────────────────────────────────
function sessionToken(req) { return req.session.githubToken || null; }
function sessionUser(req)  { return req.session.githubUser  || null; }

function requireAuth(req, res, next) {
  const token = sessionToken(req);
  const user  = sessionUser(req);
  if (!token || !user) return res.status(401).json({ error: 'Not logged in' });
  // Extra guard: ensure username from session is safe before using in file paths
  if (!isValidGhUser(user)) {
    req.session.githubToken = null;
    req.session.githubUser  = null;
    return res.status(401).json({ error: 'Invalid session — please reconnect GitHub' });
  }
  next();
}

// ── Per-user file helpers ───────────────────────────────────────────────────
function userDir(ghUser) {
  if (!isValidGhUser(ghUser)) throw new Error(`Invalid GitHub username: ${ghUser}`);
  return path.join(__dirname, 'data', 'users', ghUser);
}

function readUserFile(ghUser, name) {
  try {
    const f = path.join(userDir(ghUser), name);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {}
  return null;
}

function writeUserFile(ghUser, name, data) {
  try {
    const dir = userDir(ghUser);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  } catch (e) { console.error(`[${ghUser}] write ${name} failed:`, e.message); }
}

function deleteUserFile(ghUser, name) {
  try {
    const f = path.join(userDir(ghUser), name);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) {}
}

// ── Per-user in-memory state ────────────────────────────────────────────────
const userStates = new Map();

function getState(ghUser) {
  if (!userStates.has(ghUser)) {
    userStates.set(ghUser, {
      isRunning: false,
      stopRequested: false,
      username: null,
      log: [],
      projects: [],
      currentIndex: -1,
      currentRevision: 0,
      totalRevisions: 0,
      currentPage: 0,
      // Rate-limit wait state (shown in UI as a countdown)
      isWaiting: false,
      waitUntil: null,    // ms timestamp — when we'll retry
      waitReason: null,   // 'GitHub' | 'WebSim'
      waitAttempt: 0,     // 0-indexed position in BACKOFF_STEPS
    });
  }
  return userStates.get(ghUser);
}

function addLog(st, msg, level = 'info') {
  const entry = { ts: Date.now(), level, msg };
  st.log.push(entry);
  if (st.log.length > 1000) st.log.shift();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ── Rate-limit backoff schedule ─────────────────────────────────────────────
// 5 min → 15 min → 30 min → 1 hour
const BACKOFF_STEPS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

function msToHuman(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}hr ${rem}min` : `${hrs}hr`;
}

/**
 * Sleep for `ms` milliseconds, waking every 5 s to check stopRequested.
 * Sets the "waiting" display state while sleeping.
 */
async function rateLimitSleep(st, ms, source, attempt) {
  st.isWaiting  = true;
  st.waitUntil  = Date.now() + ms;
  st.waitReason = source;
  st.waitAttempt = attempt;

  const TICK = 5_000;
  const end = Date.now() + ms;
  while (Date.now() < end && !st.stopRequested) {
    await sleep(Math.min(TICK, end - Date.now()));
  }

  st.isWaiting  = false;
  st.waitUntil  = null;
  st.waitReason = null;
  st.waitAttempt = 0;
}

/**
 * Run `fn`. If it throws `RateLimitError`, wait using the backoff schedule
 * then retry — up to BACKOFF_STEPS.length times. After that, rethrows.
 * Returns null if the user stops during a wait.
 */
async function withRateLimitRetry(st, label, fn) {
  for (let attempt = 0; attempt <= BACKOFF_STEPS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.isRateLimit || attempt === BACKOFF_STEPS.length) throw e;
      const waitMs = (e.retryAfterMs && e.retryAfterMs > 0)
        ? e.retryAfterMs
        : BACKOFF_STEPS[attempt];
      addLog(st,
        `⏳ Rate limited by ${e.source} (${label}) — waiting ${msToHuman(waitMs)} then retrying [${attempt + 1}/${BACKOFF_STEPS.length}]`,
        'warn'
      );
      await rateLimitSleep(st, waitMs, e.source, attempt);
      if (st.stopRequested) return null;
    }
  }
}

// ── WebSim concurrency limiter ──────────────────────────────────────────────
class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  acquire() {
    if (this.count < this.max) { this.count++; return Promise.resolve(); }
    return new Promise(r => this.queue.push(r)).then(() => { this.count++; });
  }
  release() {
    this.count = Math.max(0, this.count - 1);
    if (this.queue.length) this.queue.shift()();
  }
}
const websimSemaphore = new Semaphore(2);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ── Auth routes ─────────────────────────────────────────────────────────────

app.get('/api/auth/status', async (req, res) => {
  const token = sessionToken(req);
  if (!token) {
    return res.json({ github: { connected: false, user: null }, websim: { hasCookie: !!req.session.websimCookie } });
  }
  const r = await github.getGithubUser(token).catch(() => ({ ok: false }));
  if (!r.ok) {
    req.session.githubToken = null;
    req.session.githubUser  = null;
    return res.json({ github: { connected: false, user: null }, websim: { hasCookie: !!req.session.websimCookie } });
  }
  res.json({
    github: { connected: true, user: r.user.login },
    websim: { hasCookie: !!req.session.websimCookie },
  });
});

app.get('/auth/github', (req, res) => {
  const clientId = github.getClientId();
  if (!clientId) return res.status(500).send('GITHUB_CLIENT_ID not configured.');
  const oauthState = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = oauthState;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${APP_URL}/auth/github/callback`,
    scope: 'repo',
    state: oauthState,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/github/callback', async (req, res) => {
  const { code, state: returned } = req.query;
  if (!code) return res.send('<script>alert("No code from GitHub");location="/"</script>');
  if (!req.session.oauthState || returned !== req.session.oauthState) {
    return res.send('<script>alert("State mismatch — please try again");location="/"</script>');
  }
  try {
    const token = await github.exchangeCodeForToken(
      github.getClientId(), github.getClientSecret(), code,
      `${APP_URL}/auth/github/callback`
    );
    const user = await github.getGithubUser(token);
    if (!user.ok) throw new Error('Token valid but user fetch failed');
    req.session.githubToken = token;
    req.session.githubUser  = user.user.login;
    req.session.oauthState  = null;
    res.redirect('/?github=connected');
  } catch (e) {
    const msg = (e.message || 'Unknown error').replace(/["']/g, '');
    res.send(`<script>alert("Auth failed: ${msg}");location="/"</script>`);
  }
});

app.delete('/api/auth/github', (req, res) => {
  req.session.githubToken = null;
  req.session.githubUser  = null;
  res.json({ ok: true });
});

app.post('/api/auth/websim', (req, res) => {
  const { cookie } = req.body;
  if (!cookie || typeof cookie !== 'string') return res.status(400).json({ error: 'cookie required' });
  req.session.websimCookie = cookie.trim().slice(0, 8192); // cap at 8k
  res.json({ ok: true });
});

app.delete('/api/auth/websim', (req, res) => {
  req.session.websimCookie = null;
  res.json({ ok: true });
});

// ── Tracker routes ──────────────────────────────────────────────────────────

app.get('/api/tracker', requireAuth, (req, res) => {
  res.json(tracker.getAll(sessionUser(req)));
});
app.delete('/api/tracker', requireAuth, (req, res) => {
  tracker.clear(sessionUser(req));
  res.json({ ok: true });
});
app.delete('/api/tracker/:id', requireAuth, (req, res) => {
  tracker.remove(sessionUser(req), req.params.id);
  res.json({ ok: true });
});

// ── Run-state routes ────────────────────────────────────────────────────────

app.get('/api/run-state', requireAuth, (req, res) => {
  res.json(readUserFile(sessionUser(req), 'run-state.json'));
});
app.delete('/api/run-state', requireAuth, (req, res) => {
  deleteUserFile(sessionUser(req), 'run-state.json');
  res.json({ ok: true });
});

// ── Checkpoint routes ───────────────────────────────────────────────────────

app.get('/api/checkpoint', requireAuth, (req, res) => {
  res.json(readUserFile(sessionUser(req), 'checkpoint.json'));
});
app.delete('/api/checkpoint', requireAuth, (req, res) => {
  deleteUserFile(sessionUser(req), 'checkpoint.json');
  res.json({ ok: true });
});

// ── Status polling ──────────────────────────────────────────────────────────

app.get('/api/status', requireAuth, (req, res) => {
  const st   = getState(sessionUser(req));
  const proj = st.currentIndex >= 0 ? st.projects[st.currentIndex] : null;
  res.json({
    isRunning: st.isRunning,
    isWaiting: st.isWaiting,
    waitUntil: st.waitUntil,
    waitReason: st.waitReason,
    waitAttempt: st.waitAttempt,
    username: st.username,
    currentPage: st.currentPage,
    totalProjects: st.projects.length,
    currentIndex: st.currentIndex,
    currentProject: proj ? {
      id: proj.id,
      slug: proj.slug,
      title: proj.title || proj.slug,
      status: proj._status,
      revisionsDone: st.currentRevision,
      revisionsTotal: st.totalRevisions,
      githubUrl: proj._githubUrl,
      error: proj._error,
      steps: proj._steps || null,
    } : null,
    projects: st.projects.map((p, i) => ({
      id: p.id,
      slug: p.slug,
      title: p.title || p.slug,
      status: p._status || 'queued',
      githubUrl: p._githubUrl || null,
      error: p._error || null,
      steps: p._steps || null,
      isCurrent: i === st.currentIndex,
    })),
    log: st.log.slice(-100),
  });
});

// ── Start / Stop / Retry ────────────────────────────────────────────────────

app.post('/api/process/start', requireAuth, async (req, res) => {
  const ghToken = sessionToken(req);
  const ghUser  = sessionUser(req);
  const st = getState(ghUser);

  if (st.isRunning) {
    return res.status(409).json({ error: 'Export already running. Stop it before starting a new one.' });
  }

  const {
    username,
    skipCompleted = true,
    maxProjects = 0,
    resumeCursor = null,
    fixBrokenHtml = false,
    smartScan = false,
  } = req.body;

  if (!username) return res.status(400).json({ error: 'username required' });
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username format' });

  if (!resumeCursor) {
    st.log = [];
    st.projects = [];
    st.currentIndex = -1;
    deleteUserFile(ghUser, 'run-state.json');
  }

  res.json({ ok: true });

  runProcessing(st, ghUser, username.trim(), ghToken, !!skipCompleted, parseInt(maxProjects) || 0,
    resumeCursor || null, !!fixBrokenHtml, req.session.websimCookie || null, !!smartScan)
    .catch(e => { addLog(st, `Fatal: ${e.message}`, 'error'); st.isRunning = false; });
});

app.post('/api/process/stop', requireAuth, (req, res) => {
  const st = getState(sessionUser(req));
  st.stopRequested = true;
  addLog(st, 'Stop requested');
  res.json({ ok: true });
});

app.post('/api/process/retry/:id', requireAuth, async (req, res) => {
  const ghToken = sessionToken(req);
  const ghUser  = sessionUser(req);
  const st = getState(ghUser);

  if (st.isRunning) return res.status(409).json({ error: 'Already running — please wait' });
  const project = st.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not in current session' });

  res.json({ ok: true });

  st.isRunning = true;
  st.stopRequested = false;
  project._status = 'queued';
  project._error  = null;
  project._steps  = null;
  st.currentIndex = st.projects.indexOf(project);

  try {
    await withRateLimitRetry(st, project.slug, () =>
      processOneProject(st, project, ghToken, ghUser, req.session.websimCookie || null)
    );
  } catch (e) {
    project._status = 'failed';
    project._error  = e.message;
    tracker.markFailed(ghUser, project, e.message);
  } finally {
    st.isRunning = false;
  }
});

// ── Main pipeline ───────────────────────────────────────────────────────────

async function runProcessing(st, ghUser, username, ghToken, skipCompleted, maxProjects,
  resumeCursor, fixBrokenHtml, websimCookie, smartScan) {

  st.isRunning      = true;
  st.stopRequested  = false;
  st.username       = username;
  st.currentRevision = 0;
  st.totalRevisions = 0;

  const effectiveSkip = skipCompleted && !fixBrokenHtml;
  if (fixBrokenHtml) addLog(st, 'Fix Broken HTML mode ON — will check index.html in each repo');
  if (smartScan)     addLog(st, 'Fast Mode ON — done-only pages use 300ms delay');

  const savedCp = readUserFile(ghUser, 'checkpoint.json');
  let pageNum = resumeCursor ? (savedCp?.pageNum || 0) : 0;
  let cursor  = resumeCursor || null;
  let totalSeen = resumeCursor ? st.projects.length : 0;

  try {
    addLog(st, `${resumeCursor ? 'Continuing from checkpoint' : 'Starting fresh scan'} for @${username}${maxProjects ? ` (max ${maxProjects})` : ''}`);

    mainLoop: while (true) {
      if (st.stopRequested) { addLog(st, 'Stopped.'); break; }

      pageNum++;
      st.currentPage = pageNum;
      addLog(st, `Page ${pageNum} — fetched ${totalSeen} so far`);

      // ── Fetch page (rate-limit-aware) ──
      let page;
      try {
        page = await withRateLimitRetry(st, `page ${pageNum}`, async () => {
          await websimSemaphore.acquire();
          try {
            return await websim.fetchProjectsPage(username, websimCookie, cursor);
          } finally {
            websimSemaphore.release();
          }
        });
      } catch (e) {
        addLog(st, `Page ${pageNum} fetch failed: ${e.message}`, 'error');
        writeUserFile(ghUser, 'run-state.json', {
          username, cursor, pageNum, processedCount: totalSeen,
          error: e.message, savedAt: new Date().toISOString(),
        });
        writeUserFile(ghUser, 'checkpoint.json', {
          username, cursor, pageNum, totalSeen,
          updatedAt: new Date().toISOString(), complete: false,
        });
        addLog(st, `Checkpoint saved — use "Continue from checkpoint" to resume`, 'warn');
        break;
      }

      if (!page) break; // stopped during rate-limit wait

      const { projects: pageProjects, nextCursor } = page;
      if (!pageProjects.length) { addLog(st, 'No more projects — end of list.'); break; }

      // ── Fast Mode: entire page already done → skip quickly ──
      if (smartScan && effectiveSkip) {
        const allDone = pageProjects.every(p => tracker.isCompleted(ghUser, p.id));
        if (allDone) {
          totalSeen += pageProjects.length;
          addLog(st, `Page ${pageNum} — all ${pageProjects.length} already done, fast skip`);
          if (!nextCursor) break;
          cursor = nextCursor;
          writeUserFile(ghUser, 'checkpoint.json', {
            username, cursor, pageNum, totalSeen,
            updatedAt: new Date().toISOString(), complete: false,
          });
          await sleep(300);
          continue;
        }
      }

      // Append new projects to visible list
      for (const p of pageProjects) {
        if (!st.projects.find(x => x.id === p.id)) {
          p._status = 'queued'; p._githubUrl = null; p._error = null; p._steps = null;
          st.projects.push(p);
        }
        totalSeen++;
      }

      // ── Process each project ──
      for (const project of pageProjects) {
        if (st.stopRequested) break mainLoop;

        st.currentIndex   = st.projects.indexOf(project);
        st.currentRevision = 0;
        st.totalRevisions  = 0;

        if (effectiveSkip && tracker.isCompleted(ghUser, project.id)) {
          addLog(st, `Skip ${project.slug} (already done)`);
          project._status = 'skipped';
          continue;
        }

        try {
          const result = await withRateLimitRetry(st, project.slug, () =>
            processOneProject(st, project, ghToken, ghUser, websimCookie, { fixBrokenHtml })
          );
          // result is null when user stopped during a rate-limit wait
          if (result === null && st.stopRequested) break mainLoop;
        } catch (e) {
          project._status = 'failed';
          project._error  = e.message;
          tracker.markFailed(ghUser, project, e.message);
        }

        if (!st.stopRequested) await sleep(3000);
      }

      if (!nextCursor || st.stopRequested) break;
      if (maxProjects > 0 && totalSeen >= maxProjects) break;

      cursor = nextCursor;
      writeUserFile(ghUser, 'checkpoint.json', {
        username, cursor, pageNum, totalSeen,
        updatedAt: new Date().toISOString(), complete: false,
      });
      writeUserFile(ghUser, 'run-state.json', {
        username, cursor, pageNum, processedCount: totalSeen,
        updatedAt: new Date().toISOString(),
      });
      await sleep(2000);
    }

    if (!st.stopRequested) {
      deleteUserFile(ghUser, 'run-state.json');
      writeUserFile(ghUser, 'checkpoint.json', {
        username, cursor, pageNum, totalSeen,
        updatedAt: new Date().toISOString(), complete: true,
      });
    }
    addLog(st, st.stopRequested
      ? `Stopped at page ${pageNum} — ${totalSeen} seen.`
      : `Scan complete! ${totalSeen} projects across ${pageNum} pages.`
    );
  } finally {
    st.isRunning   = false;
    st.isWaiting   = false;
    st.waitUntil   = null;
    st.waitReason  = null;
    st.waitAttempt = 0;
  }
}

// ── Process one project ─────────────────────────────────────────────────────

async function processOneProject(st, project, ghToken, ghUser, cookie, opts = {}) {
  const { fixBrokenHtml = false } = opts;
  const pid   = project.id;
  const slug  = project.slug || pid;
  const title = project.title || slug;

  project._steps = {};

  // Fix Broken HTML: check existing GitHub repo before re-exporting
  if (fixBrokenHtml) {
    const repoName = github.safeRepoName(`websim-${slug}`);
    try {
      const r = await axios.get(
        `https://raw.githubusercontent.com/${ghUser}/${repoName}/main/index.html`,
        { headers: { Authorization: `token ${ghToken}`, 'User-Agent': 'websim-archiver' },
          timeout: 15000, responseType: 'text', validateStatus: null }
      );
      if (r.status === 200 && !websim.isBrokenHtml(r.data)) {
        addLog(st, `[${slug}] HTML is good — skipping`);
        project._status = 'skipped';
        return;
      }
      if (r.status === 200) addLog(st, `[${slug}] Broken HTML detected — re-exporting`, 'warn');
    } catch (e) {
      addLog(st, `[${slug}] HTML check failed (${e.message}) — proceeding`, 'warn');
    }
  }

  function step(name, status, detail) {
    project._steps[name] = { status, detail: detail || null };
    const emoji = { ok: '✓', error: '✗', warn: '⚠' }[status] || '…';
    addLog(st, `[${slug}] ${emoji} ${name}${detail ? ': ' + detail : ''}`,
      status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'info');
  }

  project._status = 'fetching';

  // 1. Revisions
  step('revisions', 'fetching');
  let revisions;
  try {
    revisions = await websim.getAllRevisions(pid, cookie);
  } catch (e) {
    step('revisions', 'error', e.message);
    throw e; // propagate (may be RateLimitError)
  }

  if (!revisions?.length) {
    const ver = project.current_version ?? 1;
    revisions = [{ version: ver, created_at: project.created_at, created_by: project.created_by }];
    step('revisions', 'warn', `No history — falling back to v${ver}`);
  } else {
    step('revisions', 'ok', `${revisions.length} revision(s)`);
  }

  st.totalRevisions = revisions.length;
  project._status = 'processing';

  // 2. Create GitHub repo
  const repoName = github.safeRepoName(`websim-${slug}`);
  step('create-repo', 'creating', repoName);
  const repo = await github.createRepo(repoName, `WebSim: ${title}`, ghToken, ghUser);
  if (!repo.ok) {
    step('create-repo', 'error', repo.error);
    throw new Error(`Create repo: ${repo.error}`);
  }
  step('create-repo', 'ok', repo.existed ? `exists ${repo.url}` : `created ${repo.url}`);

  // 3. Init local git
  step('git-init', 'ok');
  const { git, dir } = await gitOps.initRepo(pid);

  try {
    // 4. Each revision → commit
    for (let i = 0; i < revisions.length; i++) {
      if (st.stopRequested) throw new Error('Stopped by user');

      const rev = revisions[i];
      const ver = rev.version ?? (i + 1);
      st.currentRevision = i + 1;
      step(`rev-${ver}`, 'fetching', `${i + 1}/${revisions.length}`);

      let revInfo = { html: null, title: null, prompt: null };
      try {
        revInfo = await websim.getRevisionInfo(pid, ver, cookie);
      } catch (e) {
        if (e.isRateLimit) throw e; // let pipeline handle backoff
        step(`rev-${ver}`, 'warn', `getRevisionInfo failed: ${e.message}`);
      }

      const html = revInfo.html || `<!-- v${ver}: content unavailable -->`;
      if (!revInfo.html) step(`rev-${ver}`, 'warn', 'HTML placeholder used');
      if (revInfo.prompt) rev.prompt = revInfo.prompt;
      if (revInfo.title && !rev.title) rev.title = revInfo.title;

      let assets = {};
      try {
        assets = await websim.downloadAllAssets(pid, ver, cookie);
      } catch (e) {
        if (e.isRateLimit) throw e;
        step(`rev-${ver}`, 'warn', `Assets: ${e.message}`);
      }

      try {
        const msg = await gitOps.commitRevision(
          git, { 'index.html': Buffer.from(html, 'utf8'), ...assets }, { ...rev, version: ver }, dir
        );
        step(`rev-${ver}`, 'ok', msg);
      } catch (e) {
        step(`rev-${ver}`, 'error', e.message);
        throw new Error(`Commit v${ver}: ${e.message}`);
      }

      if (i < revisions.length - 1) await sleep(500);
    }

    // 5. Push
    step('push', 'pushing');
    project._status = 'pushing';
    try {
      await gitOps.pushToGithub(git, repo.cloneUrl, ghToken);
    } catch (e) {
      step('push', 'error', e.message);
      throw new Error(`Push: ${e.message}`);
    }

    // 6. Verify (GitHub indexing can lag)
    step('verify', 'checking');
    let verified = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await sleep(attempt * 1500);
      verified = await github.repoHasCommits(ghUser, repoName, ghToken);
      if (verified) break;
      if (attempt < 4) step('verify', 'checking', `attempt ${attempt}/4…`);
    }
    if (!verified) {
      step('verify', 'warn', 'could not confirm via API (repo likely fine)');
    } else {
      step('verify', 'ok', repo.url);
    }

    project._status  = 'done';
    project._githubUrl = repo.url;
    tracker.markDone(ghUser, project, repo.url, revisions.length);
    addLog(st, `[${slug}] ✓ Done → ${repo.url}`);

  } finally {
    gitOps.cleanup(pid);
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀  WebSim → GitHub  http://localhost:${PORT}\n`);
});
