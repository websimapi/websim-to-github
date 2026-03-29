'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────
const badgeGh        = document.getElementById('badge-gh');
const badgeWs        = document.getElementById('badge-ws');
const ghConnected    = document.getElementById('gh-connected');
const ghDisconnected = document.getElementById('gh-disconnected');
const ghUsername     = document.getElementById('gh-username');
const btnGhLogout    = document.getElementById('btn-gh-logout');

const wsCookie    = document.getElementById('ws-cookie');
const btnWsSave   = document.getElementById('btn-ws-save');
const btnWsClear  = document.getElementById('btn-ws-clear');

const wsUsername    = document.getElementById('ws-username');
const skipCompleted = document.getElementById('skip-completed');
const maxProjects   = document.getElementById('max-projects');
const btnStart      = document.getElementById('btn-start');
const btnStop       = document.getElementById('btn-stop');
const progressWrap  = document.getElementById('progress-bar-wrap');
const progressFill  = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

const waitRow      = document.getElementById('wait-row');
const waitMsg      = document.getElementById('wait-msg');
const waitCountdown = document.getElementById('wait-countdown');

const checkpointBanner      = document.getElementById('checkpoint-banner');
const checkpointInfo        = document.getElementById('checkpoint-info');
const btnContinueCheckpoint = document.getElementById('btn-continue-checkpoint');
const btnClearCheckpoint    = document.getElementById('btn-clear-checkpoint');

const resumeBanner    = document.getElementById('resume-banner');
const resumeInfo      = document.getElementById('resume-info');
const btnResume       = document.getElementById('btn-resume');
const btnDismissResume = document.getElementById('btn-dismiss-resume');

const trackerList     = document.getElementById('tracker-list');
const btnClearTracker = document.getElementById('btn-clear-tracker');

const logOutput   = document.getElementById('log-output');
const btnClearLog = document.getElementById('btn-clear-log');

const projectList = document.getElementById('project-list');

// ── State ─────────────────────────────────────────────────────────────────
let pollTimer = null;
let countdownTimer = null;
let lastLogTs = 0;
let savedRunState = null;
let isGhConnected = false;
let currentWaitUntil = null; // ms timestamp for rate-limit countdown

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function setBadge(el, cls, label) {
  el.className = 'badge' + (cls ? ` ${cls}` : '');
  el.querySelector('.badge-label').textContent = label;
}

function enableStart() {
  const hasUser = wsUsername.value.trim().length > 0;
  btnStart.disabled = !(isGhConnected && hasUser);
}

wsUsername.addEventListener('input', enableStart);

// ── Auth status ───────────────────────────────────────────────────────────
async function refreshAuth() {
  try {
    const r = await fetch('/api/auth/status');
    const d = await r.json();

    if (d.github.connected) {
      isGhConnected = true;
      setBadge(badgeGh, 'connected', `GitHub: @${d.github.user}`);
      ghConnected.style.display = '';
      ghDisconnected.style.display = 'none';
      ghUsername.textContent = d.github.user;
      enableStart();
    } else {
      isGhConnected = false;
      setBadge(badgeGh, '', 'GitHub: Not Connected');
      ghConnected.style.display = 'none';
      ghDisconnected.style.display = '';
      btnStart.disabled = true;
    }

    if (d.websim.hasCookie) {
      setBadge(badgeWs, 'connected', 'WebSim: Cookie Set');
      btnWsClear.style.display = '';
    } else {
      setBadge(badgeWs, 'warning', 'WebSim: No Cookie');
      btnWsClear.style.display = 'none';
    }
  } catch (e) { console.error('Auth error:', e); }
}

btnGhLogout.addEventListener('click', async () => {
  if (!confirm('Disconnect GitHub?')) return;
  await fetch('/api/auth/github', { method: 'DELETE' });
  await refreshAuth();
});

// ── WebSim cookie ─────────────────────────────────────────────────────────
btnWsSave.addEventListener('click', async () => {
  const val = wsCookie.value.trim();
  if (!val) return alert('Paste a cookie string first');
  await fetch('/api/auth/websim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie: val }),
  });
  wsCookie.value = '';
  await refreshAuth();
});

btnWsClear.addEventListener('click', async () => {
  await fetch('/api/auth/websim', { method: 'DELETE' });
  await refreshAuth();
});

// ── Checkpoint banner ─────────────────────────────────────────────────────
let savedCheckpoint = null;

async function checkCheckpoint() {
  if (!isGhConnected) { checkpointBanner.style.display = 'none'; return; }
  try {
    const r = await fetch('/api/checkpoint');
    savedCheckpoint = r.ok ? await r.json() : null;
    if (savedCheckpoint && !savedCheckpoint.complete) {
      const ago = savedCheckpoint.updatedAt ? timeSince(savedCheckpoint.updatedAt) : '';
      checkpointInfo.textContent = `@${savedCheckpoint.username} — page ${savedCheckpoint.pageNum}, ${savedCheckpoint.totalSeen} projects scanned${ago ? ', ' + ago : ''}`;
      checkpointBanner.style.display = '';
    } else if (savedCheckpoint?.complete) {
      checkpointInfo.textContent = `@${savedCheckpoint.username} — full scan completed, ${savedCheckpoint.totalSeen} projects, ${savedCheckpoint.pageNum} pages`;
      checkpointBanner.style.display = '';
    } else {
      checkpointBanner.style.display = 'none';
    }
  } catch (_) { checkpointBanner.style.display = 'none'; }
}

function timeSince(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins/60)}h ago`;
}

btnContinueCheckpoint.addEventListener('click', async () => {
  if (!savedCheckpoint) return;
  checkpointBanner.style.display = 'none';
  wsUsername.value = savedCheckpoint.username;
  await startExport(savedCheckpoint.cursor);
});

btnClearCheckpoint.addEventListener('click', async () => {
  await fetch('/api/checkpoint', { method: 'DELETE' });
  savedCheckpoint = null;
  checkpointBanner.style.display = 'none';
});

// ── Resume banner ─────────────────────────────────────────────────────────
async function checkResume() {
  if (!isGhConnected) { resumeBanner.style.display = 'none'; return; }
  try {
    const r = await fetch('/api/run-state');
    if (!r.ok) { resumeBanner.style.display = 'none'; return; }
    savedRunState = await r.json();
    if (savedRunState) {
      resumeInfo.textContent = `@${savedRunState.username} — page ${savedRunState.pageNum || '?'}, ${savedRunState.processedCount} projects seen`;
      resumeBanner.style.display = '';
    } else {
      resumeBanner.style.display = 'none';
    }
  } catch (_) { resumeBanner.style.display = 'none'; }
}

btnResume.addEventListener('click', async () => {
  if (!savedRunState) return;
  resumeBanner.style.display = 'none';
  wsUsername.value = savedRunState.username;
  await startExport(savedRunState.cursor);
});

btnDismissResume.addEventListener('click', async () => {
  await fetch('/api/run-state', { method: 'DELETE' });
  savedRunState = null;
  resumeBanner.style.display = 'none';
});

// ── Start / Stop ──────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => startExport(null));

async function startExport(resumeCursor) {
  const username = wsUsername.value.trim().replace('@', '');
  if (!username) return alert('Enter a WebSim username');

  btnStart.disabled = true;
  btnStop.disabled = false;
  progressWrap.style.display = '';
  if (!resumeCursor) {
    projectList.innerHTML = '<p class="hint">Loading…</p>';
    lastLogTs = 0;
    logOutput.innerHTML = '';
  }

  const res = await fetch('/api/process/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      skipCompleted: skipCompleted.checked,
      maxProjects: parseInt(maxProjects.value) || 0,
      resumeCursor: resumeCursor || null,
      fixBrokenHtml: fixBrokenHtml.checked,
      smartScan: smartScan.checked,
    }),
  });
  const d = await res.json();
  if (!res.ok) {
    alert(`Error: ${d.error}`);
    btnStart.disabled = false;
    btnStop.disabled = true;
    return;
  }

  startPolling();
}

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  btnStop.textContent = 'Stopping…';
  await fetch('/api/process/stop', { method: 'POST' });
});

// ── Wait / rate-limit countdown ───────────────────────────────────────────
function renderWait(d) {
  if (!d.isWaiting || !d.waitUntil) {
    waitRow.style.display = 'none';
    currentWaitUntil = null;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    return;
  }

  currentWaitUntil = d.waitUntil;
  const attempt = (d.waitAttempt ?? 0) + 1;
  const total = 4; // BACKOFF_STEPS.length
  waitMsg.textContent = `Rate limited by ${d.waitReason} — auto-retrying in`;
  waitRow.style.display = '';
  progressWrap.style.display = '';

  function updateCountdown() {
    const rem = Math.max(0, currentWaitUntil - Date.now());
    const mins = Math.floor(rem / 60000);
    const secs = Math.floor((rem % 60000) / 1000);
    waitCountdown.textContent = `${mins}:${String(secs).padStart(2, '0')} (attempt ${attempt}/${total})`;
    if (rem === 0 && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  updateCountdown();
  if (!countdownTimer) {
    countdownTimer = setInterval(updateCountdown, 1000);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, 1500);
  pollStatus();
}

async function pollStatus() {
  if (!isGhConnected) return;
  try {
    const r = await fetch('/api/status');
    if (r.status === 401) return;
    const d = await r.json();
    renderWait(d);
    renderStatus(d);

    if (d.isRunning) {
      btnStart.disabled = true;
      btnStop.disabled = false;
      progressWrap.style.display = '';
    } else {
      waitRow.style.display = 'none';
      clearInterval(pollTimer);
      pollTimer = null;
      enableStart();
      btnStop.disabled = true;
      btnStop.textContent = 'Stop';
      progressWrap.style.display = 'none';
      refreshTracker();
      checkResume();
    }
  } catch (e) { console.error('Poll error:', e); }
}

function renderStatus(data) {
  // Progress bar
  if (data.totalProjects > 0 || data.isRunning) {
    const done = data.projects.filter(p => ['done','skipped'].includes(p.status)).length;
    const pct = data.totalProjects > 0 ? Math.round(done / data.totalProjects * 100) : 0;
    progressFill.style.width = pct + '%';
    let lbl = data.currentPage ? `Page ${data.currentPage} · ` : '';
    lbl += `${done}/${data.totalProjects} this session`;
    if (data.currentProject) {
      const cp = data.currentProject;
      if (cp.revisionsTotal > 0)
        lbl += ` — v${cp.revisionsDone}/${cp.revisionsTotal} of "${cp.title}"`;
      else
        lbl += ` — "${cp.title}"`;
    }
    progressLabel.textContent = lbl;
  }

  // Log
  const newEntries = data.log.filter(e => e.ts > lastLogTs);
  for (const e of newEntries) {
    const div = document.createElement('div');
    div.className = `log-entry ${e.level}`;
    div.textContent = `[${new Date(e.ts).toLocaleTimeString()}] ${e.msg}`;
    logOutput.appendChild(div);
  }
  if (newEntries.length) {
    logOutput.scrollTop = logOutput.scrollHeight;
    lastLogTs = newEntries[newEntries.length - 1].ts;
  }

  // Project list
  if (!data.projects.length) return;
  projectList.innerHTML = '';

  for (const p of data.projects) {
    const el = document.createElement('div');
    const statusCls = p.status === 'done' ? 'done' : p.status === 'failed' ? 'failed' : p.isCurrent ? 'active' : '';
    el.className = `project-item ${statusCls}`;

    const icon = { queued:'○', fetching:'⟳', processing:'⟳', pushing:'↑', done:'✓', failed:'!', skipped:'—' }[p.status] || '○';

    let sub = `/${esc(p.slug)}`;
    if (p.githubUrl) sub += ` · <a href="${esc(p.githubUrl)}" target="_blank">→ GitHub</a>`;

    let stepsHtml = '';
    if (p.steps && (p.status === 'failed' || p.isCurrent)) {
      const entries = Object.entries(p.steps);
      if (entries.length) {
        stepsHtml = '<div class="steps-list">' + entries.map(([k, v]) => {
          const sc = v.status === 'ok' ? 'step-ok' : v.status === 'error' ? 'step-err' : v.status === 'warn' ? 'step-warn' : 'step-run';
          const ic = v.status === 'ok' ? '✓' : v.status === 'error' ? '✗' : v.status === 'warn' ? '⚠' : '…';
          return `<span class="step ${sc}">${ic} ${esc(k)}${v.detail ? ': ' + esc(v.detail) : ''}</span>`;
        }).join('') + '</div>';
      }
    }

    let errorHtml = '';
    if (p.status === 'failed') {
      errorHtml = `
        <div class="pi-error">${esc(p.error)}</div>
        <button class="btn-sm btn-retry" data-id="${esc(p.id)}">Retry</button>
      `;
    }

    el.innerHTML = `
      <div class="pi-icon ${p.status}">${icon}</div>
      <div class="pi-info">
        <div class="pi-title">${esc(p.title || p.slug)}</div>
        <div class="pi-sub">${sub}</div>
        ${stepsHtml}
        ${errorHtml}
      </div>
    `;
    projectList.appendChild(el);
  }

  projectList.querySelectorAll('.btn-retry').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      const r = await fetch(`/api/process/retry/${id}`, { method: 'POST' });
      if (!r.ok) {
        const d = await r.json();
        alert(`Retry failed: ${d.error}`);
        btn.disabled = false;
        btn.textContent = 'Retry';
        return;
      }
      startPolling();
    });
  });
}

// ── Tracker ───────────────────────────────────────────────────────────────
async function refreshTracker() {
  if (!isGhConnected) {
    trackerList.innerHTML = '<p class="hint">Connect GitHub to see your exports.</p>';
    return;
  }
  const items = await fetch('/api/tracker').then(r => r.json()).catch(() => []);
  if (!items.length) {
    trackerList.innerHTML = '<p class="hint">No completed exports yet.</p>';
    return;
  }
  trackerList.innerHTML = '';
  for (const item of [...items].reverse()) {
    const el = document.createElement('div');
    el.className = 'tracker-item';
    const ghLink = item.githubUrl
      ? `<a href="${esc(item.githubUrl)}" target="_blank">${esc(item.githubUrl.replace('https://github.com/',''))}</a>`
      : esc(item.error || 'failed');
    el.innerHTML = `
      <div class="ti-info">
        <div class="ti-title">${esc(item.title || item.websimSlug)}</div>
        <div class="ti-url">${ghLink}</div>
      </div>
      <span class="ti-badge ${item.status}">${item.status}</span>
    `;
    trackerList.appendChild(el);
  }
}

btnClearTracker.addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  await fetch('/api/tracker', { method: 'DELETE' });
  refreshTracker();
});

// ── Log clear ─────────────────────────────────────────────────────────────
btnClearLog.addEventListener('click', () => {
  logOutput.innerHTML = '';
  lastLogTs = 0;
});

// ── Fix Broken HTML toggle ─────────────────────────────────────────────────
const fixBrokenHtml = document.getElementById('fix-broken-html');
const smartScan     = document.getElementById('smart-scan');

fixBrokenHtml.addEventListener('change', () => {
  if (fixBrokenHtml.checked) {
    skipCompleted.checked = false;
    skipCompleted.disabled = true;
    smartScan.checked = false;
    smartScan.disabled = true;
  } else {
    skipCompleted.disabled = false;
    smartScan.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
if (window.location.search.includes('github=connected')) history.replaceState({}, '', '/');

refreshAuth().then(() => {
  refreshTracker();
  checkResume();
  checkCheckpoint();

  // If our own export was already running when page loaded, resume polling
  if (isGhConnected) {
    fetch('/api/status').then(r => r.json()).then(d => {
      if (d.isRunning) {
        btnStart.disabled = true;
        btnStop.disabled = false;
        progressWrap.style.display = '';
        startPolling();
      }
    }).catch(() => {});
  }
});

setInterval(refreshAuth, 8000);
