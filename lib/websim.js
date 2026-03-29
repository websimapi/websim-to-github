'use strict';

const axios = require('axios');

const WEBSIM_BASE = 'https://websim.com/api/v1';
const CDN_BASE = (projectId) => `https://${projectId}.c.websim.com`;

const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://websim.com/',
  'Origin': 'https://websim.com',
};

function buildHeaders(cookie, accept) {
  const headers = { ...browserHeaders };
  if (accept) headers['Accept'] = accept;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiGet(path, cookie, params = {}, maxRetries = 4) {
  const url = `${WEBSIM_BASE}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: buildHeaders(cookie),
        params,
        timeout: 30000,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      lastErr = err;
      // Retry on server errors and rate limits
      if (attempt < maxRetries && (status === 500 || status === 429 || status === 503 || !status)) {
        const wait = attempt * 4000; // 4s, 8s, 12s
        console.log(`[WebSim] ${status || 'timeout'} on ${path} — retry ${attempt}/${maxRetries - 1} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      throw new Error(`WebSim ${status || 'ERR'} ${path}: ${msg}`);
    }
  }
  throw lastErr;
}

// ---- User projects — fetch one page, return projects + nextCursor ----
async function fetchProjectsPage(username, cookie, cursor = null) {
  const params = { first: 20 };
  if (cursor) params.after = cursor;

  const response = await apiGet(`/users/${username}/projects`, cookie, params);

  let items = [];
  let meta = null;

  if (response.projects) {
    items = response.projects.data || [];
    meta = response.projects.meta;
  } else if (response.data) {
    items = response.data;
    meta = response.meta;
  }

  const projects = items.map(item => {
    if (item && !item.id && item.project) return item.project;
    return item;
  }).filter(p => p && p.id);

  const nextCursor = (meta?.has_next_page && meta?.end_cursor) ? meta.end_cursor : null;
  return { projects, nextCursor };
}

// Legacy: generator for backwards compat
async function* userProjectsGenerator(username, cookie, startCursor = null) {
  let cursor = startCursor;
  let page = 0;
  while (page < 2000) {
    const { projects, nextCursor } = await fetchProjectsPage(username, cookie, cursor);
    for (const p of projects) yield p;
    if (!nextCursor) break;
    cursor = nextCursor;
    await sleep(1000); // gentle pacing between pages
    page++;
  }
}

async function getAllUserProjects(username, cookie) {
  const projects = [];
  for await (const p of userProjectsGenerator(username, cookie)) {
    projects.push(p);
  }
  return projects;
}

// ---- Revisions (all pages) ----
async function getAllRevisions(projectId, cookie) {
  let all = [];
  let cursor = null;
  let page = 0;
  const MAX_PAGES = 500;

  while (page < MAX_PAGES) {
    const params = { first: 50 };
    if (cursor) params.after = cursor;

    let response;
    try {
      response = await apiGet(`/projects/${projectId}/revisions`, cookie, params);
    } catch (e) {
      console.error(`[WebSim] Revision page ${page} failed:`, e.message);
      break;
    }

    // Response: { revisions: { data: [{ cursor, project_revision: {...} }], meta: {} } }
    //       or: { revisions: [...] }  (direct array, unlikely but handled)
    let pageData = [];
    let meta = null;

    if (response.revisions?.data) {
      pageData = response.revisions.data;
      meta = response.revisions.meta;
    } else if (Array.isArray(response.revisions)) {
      pageData = response.revisions;
    } else if (response.data) {
      pageData = response.data;
      meta = response.meta;
    } else if (Array.isArray(response)) {
      pageData = response;
    }

    if (pageData.length === 0) break;

    // Unwrap project_revision from each item
    const revisions = pageData.map(item => {
      if (item && item.project_revision) return item.project_revision;
      if (item && item.revision) return item.revision;
      return item;
    }).filter(r => r && typeof r === 'object');

    all.push(...revisions);

    if (meta?.has_next_page && meta?.end_cursor) {
      cursor = meta.end_cursor;
    } else {
      break;
    }
    page++;
  }

  // Normalize version field and deduplicate
  const unique = new Map();
  for (const r of all) {
    if (r.version === undefined && r.revision_number !== undefined) r.version = r.revision_number;
    const key = r.version !== undefined ? r.version : r.id;
    if (key !== undefined) unique.set(key, r);
  }

  return Array.from(unique.values()).sort((a, b) => (a.version || 0) - (b.version || 0));
}

// ---- Detect WebSim wrapper/shell pages (not real project HTML) ----
function isBrokenHtml(html) {
  if (!html || typeof html !== 'string') return true;
  const text = html.trim();
  if (text.length < 50) return true;
  // Next.js SPA shell (websim.com's own app)
  if (text.includes('__NEXT_DATA__')) return true;
  if (text.includes('_next/static')) return true;
  // WebSim project viewer iframe wrapper
  if (text.includes('result-iframe-wrap')) return true;
  // JSON error response
  if (text.startsWith('{') && text.includes('"error"')) return true;
  return false;
}

// CDN headers that include Referer so websim.com CDN serves the real HTML
const cdnHeaders = {
  'User-Agent': browserHeaders['User-Agent'],
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Referer': 'https://websim.com/',
  'Origin': 'https://websim.com',
};

// ---- Get HTML for a specific revision ----
async function getRevisionHtml(projectId, version, cookie) {
  // Strategy 1: CDN with version + Referer (primary path)
  try {
    const cdnUrl = `${CDN_BASE(projectId)}/index.html?v=${version}`;
    const res = await axios.get(cdnUrl, {
      headers: cdnHeaders,
      timeout: 20000,
      responseType: 'text',
    });
    if (res.status === 200 && !isBrokenHtml(res.data)) {
      console.log(`[WebSim] ✅ HTML via CDN+Referer (v${version}, ${res.data.length}b)`);
      return res.data;
    }
    if (res.status === 200) {
      console.log(`[WebSim] ⚠ CDN returned wrapper/broken page (v${version}) — trying fallbacks`);
    }
  } catch (e) {
    console.log(`[WebSim] CDN strategy 1 failed (${e.response?.status || e.message}) — trying fallbacks`);
  }

  // Strategy 2: CDN without version param (gets latest)
  try {
    const cdnUrl = `${CDN_BASE(projectId)}/index.html`;
    const res = await axios.get(cdnUrl, {
      headers: cdnHeaders,
      timeout: 20000,
      responseType: 'text',
    });
    if (res.status === 200 && !isBrokenHtml(res.data)) {
      console.log(`[WebSim] ✅ HTML via CDN no-version+Referer (${res.data.length}b)`);
      return res.data;
    }
  } catch (_) {}

  // Strategy 3: API revision metadata (check for HTML fields)
  try {
    const data = await apiGet(`/projects/${projectId}/revisions/${version}`, cookie);
    const rev = data.project_revision || data.revision || data;
    const html = rev.html || (typeof rev.content === 'string' ? rev.content : null) || rev.content?.html || rev.source || rev.code;
    if (html && !isBrokenHtml(html)) {
      console.log(`[WebSim] ✅ HTML via API revision field (${html.length}b)`);
      return html;
    }
  } catch (_) {}

  // Strategy 4: API /html endpoint (often 403 without auth)
  try {
    const res = await axios.get(`${WEBSIM_BASE}/projects/${projectId}/revisions/${version}/html`, {
      headers: buildHeaders(cookie, 'text/html'),
      timeout: 15000,
      responseType: 'text',
    });
    if (res.status === 200 && res.data && !isBrokenHtml(res.data)) {
      console.log(`[WebSim] ✅ HTML via API /html endpoint (${res.data.length}b)`);
      return typeof res.data === 'string' ? res.data : null;
    }
  } catch (_) {}

  console.log(`[WebSim] ⚠ All HTML strategies failed for ${projectId} v${version} — project may be deleted/private`);
  return null;
}

// ---- Get assets list for a revision ----
async function getAssets(projectId, version, cookie) {
  let all = [];
  let cursor = null;
  let page = 0;

  while (page < 50) {
    const params = { first: 50 };
    if (cursor) params.after = cursor;

    let res;
    try {
      res = await apiGet(`/projects/${projectId}/revisions/${version}/assets`, cookie, params);
    } catch (e) {
      console.warn(`[WebSim] Assets page ${page} failed:`, e.message);
      break;
    }

    // Response: { assets: [...] } or { assets: { data: [], meta: {} } } or { data: [] }
    let pageData = [];
    let meta = null;

    if (Array.isArray(res.assets)) {
      pageData = res.assets;
      // No pagination metadata when assets is a plain array
    } else if (res.assets?.data) {
      pageData = res.assets.data;
      meta = res.assets.meta;
    } else if (res.data) {
      pageData = res.data;
      meta = res.meta;
    } else if (Array.isArray(res)) {
      pageData = res;
    }

    if (pageData.length === 0) break;
    all.push(...pageData);

    if (meta?.has_next_page && meta?.end_cursor) {
      cursor = meta.end_cursor;
    } else {
      break; // No more pages or no meta
    }
    page++;
  }

  return all;
}

// ---- Download a single asset's content ----
async function fetchAssetContent(projectId, version, assetPath, cookie) {
  const isText = /\.(html|js|mjs|jsx|ts|tsx|css|json|txt|md|xml|svg|csv)$/i.test(assetPath);

  // Strategy 1: CDN URL (works without auth for public projects)
  try {
    const cdnUrl = `${CDN_BASE(projectId)}/${encodeURIComponent(assetPath)}?v=${version}&t=${Date.now()}`;
    const res = await axios.get(cdnUrl, {
      headers: { 'User-Agent': browserHeaders['User-Agent'] },
      timeout: 25000,
      responseType: 'arraybuffer',
    });
    if (res.status === 200 && res.data && res.data.byteLength > 0) {
      const buf = Buffer.from(res.data);
      // Sanity check for binary files: reject HTML error pages
      if (!isText) {
        const preview = buf.slice(0, 50).toString('utf8').toLowerCase().trim();
        if (preview.startsWith('<!doctype') || preview.startsWith('<html')) return null;
      }
      return buf;
    }
  } catch (_) {}

  // Strategy 2: CDN URL without encoded path (for nested paths like assets/file.js)
  try {
    const cdnUrl = `${CDN_BASE(projectId)}/${assetPath}?v=${version}`;
    const res = await axios.get(cdnUrl, {
      headers: { 'User-Agent': browserHeaders['User-Agent'] },
      timeout: 25000,
      responseType: 'arraybuffer',
    });
    if (res.status === 200 && res.data?.byteLength > 0) {
      return Buffer.from(res.data);
    }
  } catch (_) {}

  // Strategy 3: API content endpoint
  try {
    const res = await axios.get(
      `${WEBSIM_BASE}/projects/${projectId}/revisions/${version}/assets/${encodeURIComponent(assetPath)}/content`,
      {
        headers: buildHeaders(cookie),
        timeout: 25000,
        responseType: 'arraybuffer',
      }
    );
    if (res.status === 200 && res.data?.byteLength > 0) {
      return Buffer.from(res.data);
    }
  } catch (_) {}

  return null;
}

// ---- Download all assets for a revision ----
async function downloadAllAssets(projectId, version, cookie) {
  const assetList = await getAssets(projectId, version, cookie);
  const files = {};

  const CONCURRENCY = 3;
  for (let i = 0; i < assetList.length; i += CONCURRENCY) {
    const chunk = assetList.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (asset) => {
      const rawPath = asset.path;
      if (!rawPath) return;
      const cleanPath = rawPath.replace(/^(\.|\/)+/, '');
      if (!cleanPath || cleanPath.endsWith('/')) return;

      // Skip index.html here — it's handled separately by getRevisionHtml
      if (cleanPath === 'index.html') return;

      // Embedded string content
      if (typeof asset.content === 'string' && asset.content.length > 0) {
        files[cleanPath] = Buffer.from(asset.content, 'utf8');
        return;
      }

      const buf = await fetchAssetContent(projectId, version, cleanPath, cookie);
      if (buf && buf.length > 0) {
        files[cleanPath] = buf;
      } else {
        const isText = /\.(js|mjs|jsx|ts|tsx|css|json|txt|md|xml|svg|csv)$/i.test(cleanPath);
        if (isText) {
          files[cleanPath] = Buffer.from(`// Missing: ${cleanPath}\n`, 'utf8');
        }
      }
    }));
    if (i + CONCURRENCY < assetList.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  return files;
}

// ---- Get revision detail info (HTML + prompt title) ----
async function getRevisionInfo(projectId, version, cookie) {
  let html = null;
  let title = null;
  let prompt = null;

  // Fetch revision detail — response has: { project_revision, site, ... }
  try {
    const data = await apiGet(`/projects/${projectId}/revisions/${version}`, cookie);
    // Extract prompt/title from site object
    if (data.site) {
      title = data.site.title || null;
      if (data.site.prompt) {
        const p = data.site.prompt;
        prompt = typeof p === 'string' ? p : (p.text || null);
      }
    }
    // Check for HTML in revision (rare but handle)
    const rev = data.project_revision || data.revision || data;
    if (rev.html) html = rev.html;
    else if (rev.content && typeof rev.content === 'string') html = rev.content;
    else if (rev.source) html = rev.source;
  } catch (_) {}

  // Fetch HTML via CDN if not found above
  if (!html) {
    html = await getRevisionHtml(projectId, version, cookie);
  }

  return { html, title, prompt };
}

// ---- Test connectivity ----
async function testConnection(username, cookie) {
  try {
    const params = { first: 1 };
    const res = await apiGet(`/users/${username}/projects`, cookie, params);
    const items = res.projects?.data || res.data || [];
    return { ok: true, projectCount: res.projects?.meta?.has_next_page ? '20+' : items.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  fetchProjectsPage,
  getAllUserProjects,
  userProjectsGenerator,
  getAllRevisions,
  getRevisionHtml,
  getRevisionInfo,
  downloadAllAssets,
  testConnection,
  isBrokenHtml,
};
