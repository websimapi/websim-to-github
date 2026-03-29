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

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Required for secure cookies to work correctly behind Render/Heroku/nginx proxies
app.set('trust proxy', 1);

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: APP_URL.startsWith('https://'),
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// Helper: get the GitHub token for the current request (session > legacy file)
function sessionToken(req) { return req.session.githubToken || null; }
function sessionUser(req) { return req.session.githubUser || null; }

// ── Run-state: tracks interrupted run (cleared on clean finish) ────────────
const RUN_STATE_FILE = path.join(__dirname, 'data', 'run-state.json');

function saveRunState(data) {
  try {
    fs.mkdirSync(path.dirname(RUN_STATE_FILE), { recursive: true });
    fs.writeFileSync(RUN_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[State] save failed:', e.message); }
}

function loadRunState() {
  try {
    if (fs.existsSync(RUN_STATE_FILE)) return JSON.parse(fs.readFileSync(RUN_STATE_FILE, 'utf8'));
  } catch (_) {}
  return null;
}

function clearRunState() {
  try { if (fs.existsSync(RUN_STATE_FILE)) fs.unlinkSync(RUN_STATE_FILE); } catch (_) {}
}

// ── Checkpoint: permanent record of deepest page reached (never auto-cleared)
// Updated after every page. Lets user continue a scan even after a full restart.
const CHECKPOINT_FILE = path.join(__dirname, 'data', 'checkpoint.json');

function saveCheckpoint(data) {
  try {
    fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[Checkpoint] save failed:', e.message); }
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch (_) {}
  return null;
}

function clearCheckpoint() {
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
}

// ── In-memory state ────────────────────────────────────────────────────────
const state = {
  isRunning: false,
  stopRequested: false,
  username: null,
  ownerUser: null,
  log: [],
  projects: [],
  currentIndex: -1,
  currentRevision: 0,
  totalRevisions: 0,
  currentPage: 0,
};

function addLog(msg, level = 'info') {
  const entry = { ts: Date.now(), level, msg };
  state.log.push(entry);
  if (state.log.length > 1000) state.log.shift();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Auth routes ────────────────────────────────────────────────────────────

app.get('/api/auth/status', async (req, res) => {
  const token = sessionToken(req);
  const user = sessionUser(req);

  if (!token) {
    return res.json({ github: { connected: false, user: null }, websim: { hasCookie: !!req.session.websimCookie } });
  }

  // Quick verify the token is still valid
  const r = await github.getGithubUser(token);
  if (!r.ok) {
    req.session.githubToken = null;
    req.session.githubUser = null;
    return res.json({ github: { connected: false, user: null }, websim: { hasCookie: !!req.session.websimCookie } });
  }

  res.json({
    github: { connected: true, user: r.user.login },
    websim: { hasCookie: !!req.session.websimCookie },
  });
});

// GitHub OAuth — redirect to GitHub
app.get('/auth/github', (req, res) => {
  const clientId = github.getClientId();
  if (!clientId) return res.status(500).send('GitHub Client ID not configured. Set GITHUB_CLIENT_ID env var.');

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

// GitHub OAuth — callback from GitHub
app.get('/auth/github/callback', async (req, res) => {
  const { code, state: returned } = req.query;
  if (!code) return res.send('<script>alert("No code from GitHub");location="/"</script>');
  if (returned !== req.session.oauthState) return res.send('<script>alert("State mismatch — please try again");location="/"</script>');

  try {
    const token = await github.exchangeCodeForToken(
      github.getClientId(), github.getClientSecret(), code,
      `${APP_URL}/auth/github/callback`
    );
    const user = await github.getGithubUser(token);
    if (!user.ok) throw new Error('Token worked but user fetch failed');
    req.session.githubToken = token;
    req.session.githubUser = user.user.login;
    req.session.oauthState = null;
    res.redirect('/?github=connected');
  } catch (e) {
    res.send(`<script>alert("Auth failed: ${e.message.replace(/"/g,"'")}");location="/"</script>`);
  }
});

app.delete('/api/auth/github', (req, res) => {
  req.session.githubToken = null;
  req.session.githubUser = null;
  res.json({ ok: true });
});

app.post('/api/auth/websim', (req, res) => {
  const { cookie } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie required' });
  req.session.websimCookie = cookie.trim();
  res.json({ ok: true });
});

app.delete('/api/auth/websim', (req, res) => {
  req.session.websimCookie = null;
  res.json({ ok: true });
});

// ── Tracker routes ─────────────────────────────────────────────────────────

app.get('/api/tracker', (_req, res) => res.json(tracker.getAll()));
app.delete('/api/tracker', (_req, res) => { tracker.clear(); res.json({ ok: true }); });
app.delete('/api/tracker/:id', (req, res) => { tracker.remove(req.params.id); res.json({ ok: true }); });

// ── Run-state routes (resume after reload) ─────────────────────────────────

app.get('/api/run-state', (_req, res) => res.json(loadRunState() || null));
app.delete('/api/run-state', (_req, res) => { clearRunState(); res.json({ ok: true }); });

// ── Checkpoint routes (permanent deep-scan position) ──────────────────────

app.get('/api/checkpoint', (_req, res) => res.json(loadCheckpoint() || null));
app.delete('/api/checkpoint', (_req, res) => { clearCheckpoint(); res.json({ ok: true }); });

// ── Status polling ─────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const proj = state.currentIndex >= 0 ? state.projects[state.currentIndex] : null;
  res.json({
    isRunning: state.isRunning,
    username: state.username,
    ownerUser: state.ownerUser,
    currentPage: state.currentPage,
    totalProjects: state.projects.length,
    currentIndex: state.currentIndex,
    currentProject: proj ? {
      id: proj.id,
      slug: proj.slug,
      title: proj.title || proj.slug,
      status: proj._status,
      revisionsDone: state.currentRevision,
      revisionsTotal: state.totalRevisions,
      githubUrl: proj._githubUrl,
      error: proj._error,
      steps: proj._steps || null,
    } : null,
    projects: state.projects.map((p, i) => ({
      id: p.id,
      slug: p.slug,
      title: p.title || p.slug,
      status: p._status || 'queued',
      githubUrl: p._githubUrl || null,
      error: p._error || null,
      steps: p._steps || null,
      isCurrent: i === state.currentIndex,
    })),
    log: state.log.slice(-100),
  });
});

// ── Start / Stop / Retry ───────────────────────────────────────────────────

app.post('/api/process/start', async (req, res) => {
  if (state.isRunning) {
    return res.status(409).json({ error: `Busy — @${state.ownerUser || state.username} is currently exporting. Please wait.` });
  }

  const { username, skipCompleted = true, maxProjects = 0, resumeCursor = null, fixBrokenHtml = false, smartScan = false } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const ghToken = sessionToken(req);
  if (!ghToken) return res.status(401).json({ error: 'Not logged in — please connect GitHub first' });
  const ghUser = sessionUser(req);
  if (!ghUser) return res.status(401).json({ error: 'GitHub user unknown — try reconnecting' });

  // Fresh start clears state
  if (!resumeCursor) {
    state.log = [];
    state.projects = [];
    state.currentIndex = -1;
    clearRunState();
  }

  res.json({ ok: true });

  runProcessing(username, ghToken, ghUser, skipCompleted, parseInt(maxProjects) || 0, resumeCursor, fixBrokenHtml, req.session.websimCookie || null, smartScan)
    .catch(e => { addLog(`Fatal: ${e.message}`, 'error'); state.isRunning = false; });
});

app.post('/api/process/stop', (_req, res) => {
  state.stopRequested = true;
  addLog('Stop requested');
  res.json({ ok: true });
});

// Retry a single failed project without restarting everything
app.post('/api/process/retry/:id', async (req, res) => {
  if (state.isRunning) return res.status(409).json({ error: 'Server busy — please wait' });
  const project = state.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not in current session' });

  const ghToken = sessionToken(req);
  const ghUser = sessionUser(req);
  if (!ghToken || !ghUser) return res.status(401).json({ error: 'Not logged in' });

  res.json({ ok: true });

  state.isRunning = true;
  state.stopRequested = false;
  state.ownerUser = ghUser;
  project._status = 'queued';
  project._error = null;
  project._steps = null;
  state.currentIndex = state.projects.indexOf(project);

  const cookie = req.session.websimCookie || null;
  try {
    await processOneProject(project, ghToken, ghUser, cookie);
  } catch (e) {
    project._status = 'failed';
    project._error = e.message;
    tracker.markFailed(project, e.message);
  } finally {
    state.isRunning = false;
  }
});

// ── Main pipeline ──────────────────────────────────────────────────────────

async function runProcessing(username, ghToken, ghUser, skipCompleted, maxProjects, resumeCursor, fixBrokenHtml = false, websimCookie = null, smartScan = false) {
  state.isRunning = true;
  state.stopRequested = false;
  state.username = username;
  state.ownerUser = ghUser;
  state.currentRevision = 0;
  state.totalRevisions = 0;

  const cookie = websimCookie;
  let cursor = resumeCursor || null;
  let totalSeen = resumeCursor ? state.projects.length : 0;

  // fixBrokenHtml mode ignores skip-completed so every project gets checked
  const effectiveSkip = skipCompleted && !fixBrokenHtml;
  if (fixBrokenHtml) addLog('Fix Broken HTML mode ON — will check index.html in each GitHub repo');
  // fastMode: reduces inter-page delay when all projects on a page are already done
  // Does NOT stop early — always scans to the end
  if (smartScan) addLog('Fast Mode ON — done-only pages will be skipped quickly (300ms delay instead of 2s)');

  let pageNum = resumeCursor ? (loadCheckpoint()?.pageNum || 0) : 0;

  try {
    addLog(`${resumeCursor ? 'Continuing from checkpoint' : 'Starting fresh scan'} for @${username}${maxProjects ? ` (max ${maxProjects})` : ''}`);

    while (true) {
      if (state.stopRequested) { addLog('Stopped.'); break; }

      pageNum++;
      state.currentPage = pageNum;

      // ── Fetch one page ──
      addLog(`Page ${pageNum} — fetched ${totalSeen} so far`);
      let page;
      try {
        page = await websim.fetchProjectsPage(username, cookie, cursor);
      } catch (e) {
        addLog(`Page ${pageNum} fetch failed: ${e.message}`, 'error');
        // Save both run-state (for resume banner) and update checkpoint
        const stateData = { username, cursor, pageNum, processedCount: totalSeen, error: e.message, savedAt: new Date().toISOString() };
        saveRunState(stateData);
        saveCheckpoint({ username, cursor, pageNum, totalSeen, updatedAt: new Date().toISOString(), complete: false });
        addLog(`Checkpoint saved at page ${pageNum} — use "Continue from checkpoint" to resume`, 'warn');
        break;
      }

      const { projects: pageProjects, nextCursor } = page;
      if (!pageProjects.length) { addLog('No more projects — reached end of list.'); break; }

      // ── Fast Mode: if all projects on this page are already done, skip quickly ──
      if (smartScan && effectiveSkip) {
        const allDone = pageProjects.every(p => tracker.isCompleted(p.id));
        if (allDone) {
          totalSeen += pageProjects.length;
          addLog(`Page ${pageNum} — all ${pageProjects.length} already done, fast skip`);
          if (!nextCursor) break;
          cursor = nextCursor;
          saveCheckpoint({ username, cursor, pageNum, totalSeen, updatedAt: new Date().toISOString(), complete: false });
          await sleep(300); // minimal API pacing
          continue;
        }
      }

      // Append new projects to the visible list
      for (const p of pageProjects) {
        if (!state.projects.find(x => x.id === p.id)) {
          p._status = 'queued';
          p._githubUrl = null;
          p._error = null;
          p._steps = null;
          state.projects.push(p);
        }
        totalSeen++;
      }

      // ── Process each project in this page, one at a time ──
      for (const project of pageProjects) {
        if (state.stopRequested) break;

        state.currentIndex = state.projects.indexOf(project);
        state.currentRevision = 0;
        state.totalRevisions = 0;

        if (effectiveSkip && tracker.isCompleted(project.id)) {
          addLog(`Skip ${project.slug} (already done)`);
          project._status = 'skipped';
          continue;
        }

        try {
          await processOneProject(project, ghToken, ghUser, cookie, { fixBrokenHtml });
        } catch (e) {
          project._status = 'failed';
          project._error = e.message;
          tracker.markFailed(project, e.message);
        }

        if (!state.stopRequested) await sleep(3000);
      }

      if (!nextCursor || state.stopRequested) break;
      if (maxProjects > 0 && totalSeen >= maxProjects) break;

      cursor = nextCursor;
      // Save checkpoint after every page so we can always continue
      saveCheckpoint({ username, cursor, pageNum, totalSeen, updatedAt: new Date().toISOString(), complete: false });
      saveRunState({ username, cursor, pageNum, processedCount: totalSeen, updatedAt: new Date().toISOString() });
      await sleep(2000);
    }

    if (!state.stopRequested) {
      clearRunState();
      // Mark checkpoint as complete so UI can show "full scan done"
      saveCheckpoint({ username, cursor, pageNum, totalSeen, updatedAt: new Date().toISOString(), complete: true });
    }
    addLog(state.stopRequested ? `Stopped at page ${pageNum} — ${totalSeen} seen.` : `Scan complete! ${totalSeen} projects seen across ${pageNum} pages.`);
  } finally {
    state.isRunning = false;
  }
}

// ── Process one project completely ────────────────────────────────────────

async function processOneProject(project, ghToken, ghUser, cookie, opts = {}) {
  const { fixBrokenHtml = false } = opts;
  const pid = project.id;
  const slug = project.slug || pid;
  const title = project.title || slug;

  project._steps = {};

  // ── Fix Broken HTML check ──────────────────────────────────────────────
  // If fix mode is on, fetch the current index.html from GitHub.
  // If it's valid HTML (not a wrapper page), skip this project.
  // If it's broken, a 404 (repo not created yet), or unreachable — proceed.
  if (fixBrokenHtml) {
    const repoName = github.safeRepoName(`websim-${slug}`);
    try {
      const r = await axios.get(
        `https://raw.githubusercontent.com/${ghUser}/${repoName}/main/index.html`,
        {
          headers: { 'Authorization': `token ${ghToken}`, 'User-Agent': 'websim-archiver' },
          timeout: 15000,
          responseType: 'text',
          validateStatus: null,
        }
      );
      if (r.status === 200 && !websim.isBrokenHtml(r.data)) {
        addLog(`[${slug}] HTML is good — skipping`);
        project._status = 'skipped';
        return;
      }
      if (r.status === 200) {
        addLog(`[${slug}] Broken HTML detected — re-exporting`, 'warn');
      }
      // 404 = repo not created yet; fall through to normal export
    } catch (e) {
      addLog(`[${slug}] HTML check failed (${e.message}) — proceeding anyway`, 'warn');
    }
  }

  function step(name, status, detail) {
    project._steps[name] = { status, detail: detail || null };
    const emoji = status === 'ok' ? '✓' : status === 'error' ? '✗' : status === 'warn' ? '⚠' : '…';
    addLog(`[${slug}] ${emoji} ${name}${detail ? ': ' + detail : ''}`, status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'info');
  }

  project._status = 'fetching';

  // 1. Get all revisions
  step('revisions', 'fetching');
  let revisions;
  try {
    revisions = await websim.getAllRevisions(pid, cookie);
  } catch (e) {
    step('revisions', 'error', e.message);
    throw new Error(`Revisions: ${e.message}`);
  }

  if (!revisions?.length) {
    const ver = project.current_version ?? 1;
    revisions = [{ version: ver, created_at: project.created_at, created_by: project.created_by }];
    step('revisions', 'warn', `No history — falling back to v${ver}`);
  } else {
    step('revisions', 'ok', `${revisions.length} revision(s)`);
  }

  state.totalRevisions = revisions.length;
  project._status = 'processing';

  // 2. Create GitHub repo
  const repoName = github.safeRepoName(`websim-${slug}`);
  step('create-repo', 'creating', repoName);
  const repo = await github.createRepo(repoName, `WebSim: ${title}`);
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
      if (state.stopRequested) throw new Error('Stopped by user');

      const rev = revisions[i];
      const ver = rev.version ?? (i + 1);
      state.currentRevision = i + 1;
      step(`rev-${ver}`, 'fetching', `${i + 1}/${revisions.length}`);

      // HTML + title
      let revInfo = { html: null, title: null, prompt: null };
      try {
        revInfo = await websim.getRevisionInfo(pid, ver, cookie);
      } catch (e) {
        step(`rev-${ver}`, 'warn', `getRevisionInfo failed: ${e.message}`);
      }

      const html = revInfo.html || `<!-- v${ver}: content unavailable -->`;
      if (!revInfo.html) step(`rev-${ver}`, 'warn', 'HTML placeholder used');
      // Always pass prompt as primary commit message; title as fallback
      if (revInfo.prompt) rev.prompt = revInfo.prompt;
      if (revInfo.title && !rev.title) rev.title = revInfo.title;

      // Assets
      let assets = {};
      try {
        assets = await websim.downloadAllAssets(pid, ver, cookie);
      } catch (e) {
        step(`rev-${ver}`, 'warn', `Assets: ${e.message}`);
      }

      // Commit
      try {
        const msg = await gitOps.commitRevision(git, { 'index.html': Buffer.from(html, 'utf8'), ...assets }, { ...rev, version: ver }, dir);
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

    // 6. Verify — retry a few times since GitHub indexing can lag after push
    step('verify', 'checking');
    let verified = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await sleep(attempt * 1500); // 1.5s, 3s, 4.5s, 6s
      verified = await github.repoHasCommits(ghUser, repoName);
      if (verified) break;
      if (attempt < 4) step('verify', 'checking', `attempt ${attempt}/4…`);
    }
    if (!verified) {
      // Push didn't throw, so commits likely exist — warn but don't fail
      step('verify', 'warn', 'could not confirm commits via API (repo may still be fine)');
    } else {
      step('verify', 'ok', repo.url);
    }

    project._status = 'done';
    project._githubUrl = repo.url;
    tracker.markDone(project, repo.url, revisions.length);
    addLog(`[${slug}] ✓ Done → ${repo.url}`);

  } finally {
    gitOps.cleanup(pid);
  }
}


// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀  WebSim → GitHub  http://localhost:${PORT}\n`);
});
