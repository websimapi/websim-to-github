'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '../data/auth.json');
const GH_API = 'https://api.github.com';

// OAuth credentials — prefer env vars, fall back to local auth.json (for dev convenience)
function getClientId() {
  return process.env.GITHUB_CLIENT_ID || loadAuth().github_client_id || '';
}
function getClientSecret() {
  return process.env.GITHUB_CLIENT_SECRET || loadAuth().github_client_secret || '';
}

// ---- Token storage ----
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveAuth(data) {
  const current = loadAuth();
  const updated = { ...current, ...data };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(updated, null, 2));
}

function getGithubToken() {
  return loadAuth().github_token || null;
}

function getWebsimCookie() {
  return loadAuth().websim_cookie || null;
}

function setWebsimCookie(cookie) {
  saveAuth({ websim_cookie: cookie });
}

function clearGithubToken() {
  const auth = loadAuth();
  delete auth.github_token;
  delete auth.github_user;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

// ---- GitHub API helper ----
function ghApi(method, endpoint, data, token) {
  const tok = token || getGithubToken();
  return axios({
    method,
    url: `${GH_API}${endpoint}`,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    data,
    timeout: 15000,
  }).then(r => r.data);
}

// ---- Get current user ----
async function getGithubUser(token) {
  try {
    const data = await ghApi('GET', '/user', null, token);
    return { ok: true, user: data };
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

// ---- Standard OAuth web flow ----
async function exchangeCodeForToken(clientId, clientSecret, code, redirectUri) {
  const res = await axios.post(
    'https://github.com/login/oauth/access_token',
    { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
    { headers: { Accept: 'application/json' }, timeout: 10000 }
  );
  const data = res.data;
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error('No access_token in response');
  return data.access_token;
}

// ---- Device flow OAuth ----
async function startDeviceFlow(clientId) {
  const res = await axios.post(
    'https://github.com/login/device/code',
    { client_id: clientId, scope: 'repo' },
    {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    }
  );
  return res.data; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function pollDeviceFlow(clientId, deviceCode, interval, clientSecret) {
  // Returns token string on success, null if still pending, throws on error/expire
  const body = {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await axios.post(
    'https://github.com/login/oauth/access_token',
    body,
    {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    }
  );

  const data = res.data;
  if (data.access_token) return data.access_token;
  if (data.error === 'authorization_pending') return null;
  if (data.error === 'slow_down') return null;
  if (data.error === 'expired_token') throw new Error('Device code expired. Please restart auth.');
  if (data.error === 'access_denied') throw new Error('Access denied by user.');
  throw new Error(data.error_description || data.error || 'Unknown OAuth error');
}

// ---- GitHub Repo management ----
async function createRepo(repoName, description, token, owner) {
  try {
    const data = await ghApi('POST', '/user/repos', {
      name: repoName,
      description: description || `WebSim project exported to GitHub`,
      private: false,
      auto_init: false,
    }, token);
    return { ok: true, url: data.html_url, cloneUrl: data.clone_url, sshUrl: data.ssh_url };
  } catch (e) {
    const msg = e.response?.data?.errors?.[0]?.message || e.response?.data?.message || e.message;
    // If repo already exists, return its URL
    if (msg && msg.includes('already exists') && owner) {
      try {
        const existing = await ghApi('GET', `/repos/${owner}/${repoName}`, null, token);
        return { ok: true, url: existing.html_url, cloneUrl: existing.clone_url, sshUrl: existing.ssh_url, existed: true };
      } catch (_) {}
    }
    return { ok: false, error: msg };
  }
}

async function repoHasCommits(owner, repoName, token) {
  try {
    const commits = await ghApi('GET', `/repos/${owner}/${repoName}/commits?per_page=1`, null, token);
    return Array.isArray(commits) && commits.length > 0;
  } catch (_) {
    return false;
  }
}

// Safe repo name: lowercase, hyphens, max 100 chars
function safeRepoName(slug) {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-_.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'websim-project';
}

module.exports = {
  loadAuth,
  saveAuth,
  getClientId,
  getClientSecret,
  getGithubToken,
  getWebsimCookie,
  setWebsimCookie,
  clearGithubToken,
  getGithubUser,
  exchangeCodeForToken,
  createRepo,
  repoHasCommits,
  safeRepoName,
};
