'use strict';

const fs = require('fs');
const path = require('path');

const TRACKER_FILE = path.join(__dirname, '../data/tracker.json');

function load() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
    }
  } catch (_) {}
  return { projects: [] };
}

function save(data) {
  fs.mkdirSync(path.dirname(TRACKER_FILE), { recursive: true });
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
}

function isCompleted(projectId) {
  const data = load();
  return data.projects.some(p => p.websimId === projectId && p.status === 'done');
}

function markDone(project, githubUrl, revisionsCount) {
  const data = load();
  // Remove any existing entry for this project
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
  save(data);
}

function markFailed(project, error) {
  const data = load();
  data.projects = data.projects.filter(p => p.websimId !== project.id);
  data.projects.push({
    websimId: project.id,
    websimSlug: project.slug,
    title: project.title || project.slug,
    status: 'failed',
    error: error,
    failedAt: new Date().toISOString(),
  });
  save(data);
}

function getAll() {
  return load().projects;
}

function clear() {
  save({ projects: [] });
}

function remove(projectId) {
  const data = load();
  data.projects = data.projects.filter(p => p.websimId !== projectId);
  save(data);
}

module.exports = {
  isCompleted,
  markDone,
  markFailed,
  getAll,
  clear,
  remove,
};
