const express = require('express');
const crypto = require('crypto');
const { saveToken, JIRA_AUTH_BASE, JIRA_API_BASE } = require('../lib/jiraAuth');

const router = express.Router();

const REQUIRED_ENV = ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET', 'JIRA_CALLBACK_URL'];
const STATE_COOKIE = 'jira_oauth_state';
// FRONTEND_URL overrides this for other environments (e.g. local dev, a preview deploy).
const DEFAULT_FRONTEND_URL = 'https://ai-delivery-copilot.vercel.app';

function assertJiraEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing Jira OAuth env vars: ${missing.join(', ')}`);
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

router.get('/login', (req, res) => {
  try {
    assertJiraEnv();
  } catch (err) {
    return res.status(500).send(err.message);
  }

  // CSRF protection: a random state is round-tripped via an HttpOnly cookie
  // and checked against the value Jira sends back in the callback.
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader(
    'Set-Cookie',
    `${STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${req.secure ? '; Secure' : ''}`
  );

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: process.env.JIRA_CLIENT_ID,
    // Granular scopes the Agile API needs, one per resource — confirmed
    // against a real site by hitting each 401 "scope does not match" in
    // turn: read:board-scope:jira-software + read:project:jira got
    // /rest/agile/1.0/board working, then the exact same error moved to
    // /board/{id}/sprint (fixed by read:sprint:jira-software), then to
    // GET /sprint/{id}/issue — read:issue-details:jira alone (NOT
    // read:issue-details:jira-software, which doesn't exist as a grantable
    // scope) still wasn't enough; per an Atlassian community thread hitting
    // the identical error on this exact endpoint, it also needs
    // read:jql:jira (the sprint-issue endpoint takes a JQL-search-shaped
    // request under the hood).
    // Mixing these with the classic scopes below (still needed for the
    // regular /rest/api/3/* issue sync) has been accepted by this app's
    // Developer Console config without issue.
    scope: 'read:jira-work read:jira-user offline_access read:board-scope:jira-software read:project:jira read:sprint:jira-software read:issue-details:jira read:jql:jira',
    redirect_uri: process.env.JIRA_CALLBACK_URL,
    state,
    response_type: 'code',
    prompt: 'consent',
  });

  res.redirect(`${JIRA_AUTH_BASE}/authorize?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
  try {
    assertJiraEnv();

    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).send(`Jira authorization failed: ${error}`);
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!state || !cookies[STATE_COOKIE] || state !== cookies[STATE_COOKIE]) {
      return res.status(400).send('Invalid or missing OAuth state');
    }
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/; Max-Age=0`);

    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    const tokenRes = await fetch(`${JIRA_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.JIRA_CLIENT_ID,
        client_secret: process.env.JIRA_CLIENT_SECRET,
        code,
        redirect_uri: process.env.JIRA_CALLBACK_URL,
      }),
    });

    if (!tokenRes.ok) {
      return res.status(502).send(`Failed to exchange authorization code: ${await tokenRes.text()}`);
    }

    const tokenData = await tokenRes.json();

    const resourcesRes = await fetch(`${JIRA_API_BASE}/oauth/token/accessible-resources`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    if (!resourcesRes.ok) {
      return res.status(502).send(`Failed to list accessible Jira sites: ${await resourcesRes.text()}`);
    }

    const resources = await resourcesRes.json();
    const cloudId = resources?.[0]?.id;
    // e.g. "https://your-domain.atlassian.net" — used to build "Open in Jira"
    // links (`${siteUrl}/browse/${issueKey}`) since browse URLs aren't cloud-id-based.
    const siteUrl = resources?.[0]?.url || null;
    if (!cloudId) {
      return res.status(502).send('No accessible Jira sites found for this account');
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    await saveToken({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      cloudId,
      siteUrl,
    });

    const frontendUrl = process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
    res.redirect(`${frontendUrl}?jira=connected`);
  } catch (err) {
    res.status(500).send(`OAuth callback error: ${err.message}`);
  }
});

module.exports = router;
