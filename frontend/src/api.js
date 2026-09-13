import axios from 'axios';

// VITE_API_URL lets `npm run dev` keep hitting a local backend via a .env
// override, while the built app defaults to production.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://ai-delivery-copilot-backend.vercel.app';

const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
});

// Full-page navigation target, not an XHR call — OAuth requires the browser
// itself to be redirected to Jira's consent screen.
export const jiraLoginUrl = `${API_BASE_URL}/api/auth/login`;

export async function getJiraStatus() {
  const res = await api.get('/jira/status');
  return res.data;
}

// force=true recomputes lead/cycle/reopen time for every issue regardless
// of whether Jira's `updated` timestamp changed — needed once after a fix
// to that calculation itself, since otherwise already-synced issues keep
// serving their stale stored values forever.
export async function syncJira(force = false) {
  const res = await api.post('/jira/sync', null, force ? { params: { force: '1' } } : undefined);
  return res.data;
}

export async function getJiraIssues() {
  const res = await api.get('/jira/issues');
  return res.data;
}

export async function getJiraFields() {
  const res = await api.get('/jira/fields');
  return res.data;
}

export async function getFieldMapping() {
  const res = await api.get('/jira/field-mapping');
  return res.data;
}

export async function saveFieldMapping(mapping) {
  const res = await api.post('/jira/field-mapping', { mapping });
  return res.data;
}

export async function getTasks(params) {
  const res = await api.get('/jira/tasks', { params });
  return res.data;
}

export async function getTaskFilters() {
  const res = await api.get('/jira/tasks/filters');
  return res.data;
}

export async function exportTasksCsv(params) {
  const res = await api.get('/jira/tasks', { params: { ...params, export: 'csv' }, responseType: 'blob' });
  return res.data;
}

export async function getSyncProgress() {
  const res = await api.get('/jira/sync/progress');
  return res.data;
}

export async function getSyncHistory() {
  const res = await api.get('/jira/sync/history');
  return res.data;
}

export async function getTeamRoles() {
  const res = await api.get('/jira/team-roles');
  return res.data;
}

export async function saveTeamRole(team, assignee, role) {
  const res = await api.post('/jira/team-roles', { team, assignee, role });
  return res.data;
}

export async function getWipLimitsForTeam(team) {
  const res = await api.get('/jira/wip-limits', { params: { team } });
  return res.data;
}

export async function saveWipLimitsForTeam(team, entries) {
  const res = await api.post('/jira/wip-limits', { team, entries });
  return res.data;
}

export async function getTeamsFilters() {
  const res = await api.get('/teams/filters');
  return res.data;
}

export async function getTeamsReport(params) {
  const res = await api.get('/teams', { params });
  return res.data;
}

export async function getSprintsFilters() {
  const res = await api.get('/sprints/filters');
  return res.data;
}

export async function getSprintsReport(params) {
  const res = await api.get('/sprints/report', { params });
  return res.data;
}

export async function getDashboardWidgets() {
  const res = await api.get('/dashboard/widgets');
  return res.data;
}

export async function setDashboardWidgetEnabled(widgetType, enabled) {
  const res = await api.post(`/dashboard/widgets/${widgetType}`, { enabled });
  return res.data;
}

export async function getDashboardAttention(params) {
  const res = await api.get('/dashboard/attention', { params });
  return res.data;
}

export async function getReportStatus(params) {
  const res = await api.get('/reports/status', { params });
  return res.data;
}

export async function saveReportSummary(periodKey, summary) {
  const res = await api.post('/reports/summary', { periodKey, summary });
  return res.data;
}

export async function exportReportCsv(payload) {
  const res = await api.post('/reports/export', payload, { responseType: 'blob' });
  return res.data;
}

export default api;
