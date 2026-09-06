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

export async function syncJira() {
  const res = await api.post('/jira/sync');
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

export default api;
