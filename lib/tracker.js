'use strict';

const fs = require('fs');
const path = require('path');

function trackerFile(ghUser) {
  return path.join(__dirname, '../data/users', ghUser, 'tracker.json');
}

function load(ghUser) {
  try {
    const f = trackerFile(ghUser);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {}
  return { projects: [] };
}

function save(ghUser, data) {
  const f = trackerFile(ghUser);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

function isCompleted(ghUser, projectId) {
  return load(ghUser).projects.some(p => p.websimId === projectId && p.status === 'done');
}

function markDone(ghUser, project, githubUrl, revisionsCount) {
  const data = load(ghUser);
  data.projects = data.projects.filter(p => p.websimId !== project.id);
  data.projects.push({
    websimId: project.id,
    websimSlug: project.slug,
    websimUrl: `https://websim.com/@${project.created_by?.username || 'unknown'}/${project.slug}`,
    title: project.title || project.slug,
    githubUrl,
    revisionsCount,
    status: 'done',
    completedAt: new Date().toISOString(),
  });
  save(ghUser, data);
}

function markFailed(ghUser, project, error) {
  const data = load(ghUser);
  data.projects = data.projects.filter(p => p.websimId !== project.id);
  data.projects.push({
    websimId: project.id,
    websimSlug: project.slug,
    title: project.title || project.slug,
    status: 'failed',
    error,
    failedAt: new Date().toISOString(),
  });
  save(ghUser, data);
}

function getAll(ghUser) {
  return load(ghUser).projects;
}

function clear(ghUser) {
  save(ghUser, { projects: [] });
}

function remove(ghUser, projectId) {
  const data = load(ghUser);
  data.projects = data.projects.filter(p => p.websimId !== projectId);
  save(ghUser, data);
}

module.exports = { isCompleted, markDone, markFailed, getAll, clear, remove };
