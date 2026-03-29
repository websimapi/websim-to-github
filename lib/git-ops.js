'use strict';

const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORK_DIR = path.join(os.tmpdir(), 'websim-export');

function getProjectDir(projectId) {
  return path.join(WORK_DIR, projectId);
}

function ensureClean(projectId) {
  const dir = getProjectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(projectId) {
  const dir = getProjectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[Git] Cleaned up temp dir for ${projectId}`);
  }
}

// Write files dict to directory, clearing non-git files first
function writeFilesToDir(dir, files) {
  // Remove everything except .git
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }

  // Write new files
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    const fileDir = path.dirname(fullPath);
    fs.mkdirSync(fileDir, { recursive: true });
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fullPath, content);
    } else if (typeof content === 'string') {
      fs.writeFileSync(fullPath, content, 'utf8');
    } else if (content instanceof Uint8Array) {
      fs.writeFileSync(fullPath, Buffer.from(content));
    }
  }
}

// Initialize a new git repo
async function initRepo(projectId) {
  const dir = ensureClean(projectId);
  const git = simpleGit(dir);
  await git.init(['-b', 'main']);
  // Set local git config so commits work
  await git.addConfig('user.email', 'websim-export@local');
  await git.addConfig('user.name', 'WebSim Export');
  return { git, dir };
}

// Commit a revision with backdated timestamp
async function commitRevision(git, files, revision, dir) {
  const { version, created_at, created_by } = revision;
  const author = created_by?.username || 'websim';
  const dateStr = created_at || new Date().toISOString();
  // Prefer prompt (the actual user request that created this version), then title, then fallback
  const body = (revision.prompt || revision.title || revision.note || revision.description || `Version ${version}`)
    .replace(/[\r\n|]+/g, ' ')
    .trim()
    .slice(0, 250);
  const message = `v${version}: ${body}`;

  writeFilesToDir(dir, files);
  await git.add('.');

  // Check if there are staged changes
  const status = await git.status();
  const hasChanges = status.staged.length > 0 ||
    status.created.length > 0 ||
    status.deleted.length > 0 ||
    status.modified.length > 0;

  // Set GIT_COMMITTER_DATE for backdating (single-process, sequential — safe)
  const prev = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_COMMITTER_DATE = dateStr;

  try {
    const commitArgs = [
      '--date', dateStr,
      '--author', `${author} <${author}@websim.ai>`,
      '-m', message,
    ];
    if (!hasChanges) commitArgs.push('--allow-empty');
    await git.raw(['commit', ...commitArgs]);
  } finally {
    if (prev !== undefined) process.env.GIT_COMMITTER_DATE = prev;
    else delete process.env.GIT_COMMITTER_DATE;
  }

  return message;
}

// Add remote and push
async function pushToGithub(git, cloneUrl, token) {
  // Inject token into HTTPS URL
  const authedUrl = cloneUrl.replace('https://', `https://oauth2:${token}@`);

  try {
    await git.removeRemote('origin');
  } catch (_) {}

  await git.addRemote('origin', authedUrl);
  await git.push(['--set-upstream', 'origin', 'main', '--force']);
}

module.exports = {
  initRepo,
  commitRevision,
  pushToGithub,
  cleanup,
  getProjectDir,
  writeFilesToDir,
};
