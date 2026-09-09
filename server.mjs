import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = process.env.STRAVA_API_BASE || 'https://www.strava.com/api/v3';
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'hm84-stable-session-v1';
const CACHE_MS = 4 * 60 * 1000;
const BACKGROUND_SYNC_MS = 5 * 60 * 1000;

app.use(express.json());
app.use(express.static('public', { maxAge: 0 }));

let serverSession = null;
const activityCache = new Map();
const statsCache = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function unseal(value) {
  try {
    const raw = Buffer.from(value, 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
  } catch {
    return null;
  }
}
function browserSession(req) {
  return unseal(parseCookies(req).hm84_session || '');
}
function setBrowserSession(res, session) {
  res.setHeader('Set-Cookie', `hm84_session=${seal(session)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
}

async function tokenRequest(body) {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  if (!r.ok) throw new Error(`Strava token ${r.status}: ${await r.text()}`);
  return r.json();
}

async function refreshSession(session) {
  if (!session) return null;
  if (Number(session.expires_at) > Math.floor(Date.now() / 1000) + 300) return session;
  const t = await tokenRequest({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: session.refresh_token
  });
  return { ...session, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at };
}

async function usableSession(req, res) {
  // Personal single-user app: if Safari loses the cookie after a deploy/navigation,
  // recover from the server-side Strava session instead of showing "disconnected".
  let s = browserSession(req) || serverSession;
  if (!s) return null;
  const oldExpiry = s.expires_at;
  s = await refreshSession(s);
  serverSession = s;
  if (!browserSession(req) || oldExpiry !== s.expires_at) setBrowserSession(res, s);
  return s;
}

async function stravaGet(path, session) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (!r.ok) throw new Error(`Strava API ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getActivities(session, force = false) {
  const id = String(session.athlete?.id || 'me');
  const cached = activityCache.get(id);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached;
  const data = await stravaGet('/athlete/activities?per_page=200&page=1', session);
  const result = { data, at: Date.now() };
  activityCache.set(id, result);
  return result;
}

async function getStats(session, force = false) {
  const id = String(session.athlete?.id || '');
  if (!id) return null;
  const cached = statsCache.get(id);
  if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached;
  const data = await stravaGet(`/athletes/${id}/stats`, session);
  const result = { data, at: Date.now() };
  statsCache.set(id, result);
  return result;
}

async function runBackgroundSync() {
  if (!serverSession) return;
  try {
    serverSession = await refreshSession(serverSession);
    const [acts, stats] = await Promise.all([getActivities(serverSession, true), getStats(serverSession, true)]);
    console.log('Background sync', acts.data.length, 'activities', 'stats', !!stats);
  } catch (e) {
    console.error('Background sync error', e.message);
  }
}

app.get('/auth/strava', (req, res) => {
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(503).send('Strava ainda não configurado no servidor.');
  }
  const state = crypto.randomBytes(18).toString('hex');
  res.setHeader('Set-Cookie', `hm84_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  const q = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${PUBLIC_URL}/auth/strava/callback`,
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state
  });
  console.log('OAuth start');
  res.redirect(`https://www.strava.com/oauth/authorize?${q}`);
});

app.get('/auth/strava/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/?strava=denied');
    const expectedState = parseCookies(req).hm84_oauth_state;
    if (!req.query.code || !expectedState || req.query.state !== expectedState) {
      return res.status(400).send('Falha de validação do login Strava. Volte ao HM84 e tente conectar novamente.');
    }
    const t = await tokenRequest({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: req.query.code,
      grant_type: 'authorization_code'
    });
    serverSession = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at,
      athlete: t.athlete
    };
    setBrowserSession(res, serverSession);
    activityCache.clear();
    statsCache.clear();
    console.log('OAuth connected athlete', t.athlete?.id);
    await runBackgroundSync();
    res.redirect('/?strava=connected');
  } catch (e) {
    console.error('OAuth callback error', e.message);
    res.status(500).send('Erro ao conectar Strava: ' + e.message);
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const s = await usableSession(req, res);
    res.json({
      configured: !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET),
      connected: !!s,
      athlete: s?.athlete || null,
      autoRefreshMinutes: 5,
      backgroundReady: !!serverSession
    });
  } catch (e) {
    res.json({ configured: true, connected: false, error: e.message });
  }
});

app.get('/api/activities', async (req, res) => {
  try {
    const s = await usableSession(req, res);
    if (!s) return res.status(401).json({ error: 'Strava not connected' });
    const result = await getActivities(s, req.query.force === '1');
    res.json({ activities: result.data, syncedAt: new Date(result.at).toISOString(), cached: req.query.force !== '1' });
  } catch (e) {
    console.error('Activities error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/athlete-stats', async (req, res) => {
  try {
    const s = await usableSession(req, res);
    if (!s) return res.status(401).json({ error: 'Strava not connected' });
    const result = await getStats(s, req.query.force === '1');
    res.json({ stats: result?.data || null, syncedAt: result ? new Date(result.at).toISOString() : null });
  } catch (e) {
    console.error('Stats error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const s = await usableSession(req, res);
    if (!s) return res.status(401).json({ error: 'Strava not connected' });
    serverSession = s;
    await runBackgroundSync();
    const cached = activityCache.get(String(s.athlete?.id || 'me'));
    res.json({ ok: true, count: cached?.data?.length || 0, syncedAt: cached ? new Date(cached.at).toISOString() : null });
  } catch (e) {
    console.error('Manual sync error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  activityCache.clear();
  statsCache.clear();
  serverSession = null;
  res.setHeader('Set-Cookie', 'hm84_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({
  ok: true,
  stravaConfigured: !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET),
  backgroundReady: !!serverSession,
  cacheMinutes: CACHE_MS / 60000,
  backgroundSyncMinutes: BACKGROUND_SYNC_MS / 60000
}));

setInterval(runBackgroundSync, BACKGROUND_SYNC_MS).unref();
app.listen(PORT, '0.0.0.0', () => console.log(`HM84 ${PUBLIC_URL}`));
