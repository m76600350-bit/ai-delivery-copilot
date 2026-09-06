const { getPool, ensureSchema } = require('../db');

const JIRA_AUTH_BASE = 'https://auth.atlassian.com';
const JIRA_API_BASE = 'https://api.atlassian.com';

async function getStoredToken() {
  await ensureSchema();
  const { rows } = await getPool().query(
    'SELECT * FROM jira_tokens ORDER BY id DESC LIMIT 1'
  );
  return rows[0] || null;
}

// Single-tenant app: only one Jira connection is kept, so this replaces
// whatever token row already exists instead of accumulating history.
async function saveToken({ accessToken, refreshToken, expiresAt, cloudId }) {
  await ensureSchema();
  const pool = getPool();
  const existing = await pool.query('SELECT id FROM jira_tokens ORDER BY id DESC LIMIT 1');

  if (existing.rows.length) {
    await pool.query(
      `UPDATE jira_tokens
       SET access_token = $1, refresh_token = $2, expires_at = $3, cloud_id = $4, updated_at = now()
       WHERE id = $5`,
      [accessToken, refreshToken, expiresAt, cloudId, existing.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO jira_tokens (access_token, refresh_token, expires_at, cloud_id)
       VALUES ($1, $2, $3, $4)`,
      [accessToken, refreshToken, expiresAt, cloudId]
    );
  }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${JIRA_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.JIRA_CLIENT_ID,
      client_secret: process.env.JIRA_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh Jira token: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// Returns a currently-valid access token, transparently refreshing it (and
// persisting the refreshed token) if it's expired or about to expire.
async function getValidAccessToken() {
  const token = await getStoredToken();
  if (!token) {
    const err = new Error('Jira is not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const expiresAt = new Date(token.expires_at).getTime();
  const isExpiring = expiresAt - Date.now() < 60_000;

  if (!isExpiring) {
    return { accessToken: token.access_token, cloudId: token.cloud_id };
  }

  const refreshed = await refreshAccessToken(token.refresh_token);
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

  await saveToken({
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || token.refresh_token,
    expiresAt: newExpiresAt,
    cloudId: token.cloud_id,
  });

  return { accessToken: refreshed.access_token, cloudId: token.cloud_id };
}

module.exports = {
  getStoredToken,
  saveToken,
  refreshAccessToken,
  getValidAccessToken,
  JIRA_AUTH_BASE,
  JIRA_API_BASE,
};
