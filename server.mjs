import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = process.env.STRAVA_API_BASE || 'https://www.strava.com/api/v3';
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const CACHE_MS = 4 * 60 * 1000;
const BACKGROUND_SYNC_MS = 5 * 60 * 1000;

app.use(express.json());
app.use(express.static('public', { maxAge: 0 }));

const activityCache = new Map();
const statsCache = new Map();
let serverSession = null;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function key() { return crypto.createHash('sha256').update(SESSION_SECRET).digest(); }
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const plain = Buffer.from(JSON.stringify(obj));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}
function unseal(token) {
  try {
    const raw = Buffer.from(token, 'base64url');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString());
  } catch { return null; }
}
function setSession(res, session) {
  const value = seal(session);
  res.setHeader('Set-Cookie', `hm84_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
}
function getSession(req) { return unseal(cookies(req).hm84_session || ''); }

async function tokenRequest(body) {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body)
  });
  if (!r.ok) throw new Error(`Strava token ${r.status}: ${await r.text()}`);
  return r.json();
}

async function refreshSessionObject(s) {
  if (!s) return null;
  if (Number(s.expires_at) > Math.floor(Date.now() / 1000) + 300) return s;
  const t = await tokenRequest({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: s.refresh_token
  });
  return { ...s, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at };
}

async function freshSession(req, res) {
  let s = getSession(req);
  if (!s) return null;
  const before = s.expires_at;
  s = await refreshSessionObject(s);
  if (s.expires_at !== before) setSession(res, s);
  serverSession = s;
  return s;
}

async function stravaGet(path, session) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (!r.ok) throw new Error(`Strava API ${r.status}: ${await r.text()}`);
  return r.json();
}

async function activitiesFor(session, force = false) {
  const athleteId = String(session.athlete?.id || 'me');
  const cached = activityCache.get(athleteId);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached;
  const data = await stravaGet('/athlete/activities?per_page=200&page=1', session);
  const result = { data, at: Date.now() };
  activityCache.set(athleteId, result);
  return result;
}

async function statsFor(session, force = false) {
  const athleteId = String(session.athlete?.id || '');
  if (!athleteId) return null;
  const cached = statsCache.get(athleteId);
  if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached;
  const data = await stravaGet(`/athletes/${athleteId}/stats`, session);
  const result = { data, at: Date.now() };
  statsCache.set(athleteId, result);
  return result;
}

async function runBackgroundSync() {
  if (!serverSession) return;
  try {
    serverSession = await refreshSessionObject(serverSession);
    const [acts, stats] = await Promise.all([activitiesFor(serverSession, true), statsFor(serverSession, true)]);
    console.log('Background sync', acts.data.length, 'activities', 'stats', !!stats);
  } catch (e) {
    console.error('Background sync error', e.message);
  }
}

app.get('/auth/strava', (req, res) => {
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) return res.status(503).send('Strava ainda não configurado no servidor.');
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
  res.redirect(`https://www.strava.com/oauth/authorize?${q}`);
});

app.get('/auth/strava/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/?strava=denied');
    if (!req.query.code || req.query.state !== cookies(req).hm84_oauth_state) return res.status(400).send('Falha de validação do login Strava. Tente conectar novamente.');
    const t = await tokenRequest({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: req.query.code,
      grant_type: 'authorization_code'
    });
    serverSession = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, athlete: t.athlete };
    setSession(res, serverSession);
    activityCache.delete(String(t.athlete?.id || 'me'));
    statsCache.delete(String(t.athlete?.id || ''));
    setImmediate(runBackgroundSync);
    res.redirect('/?strava=connected');
  } catch (e) {
    console.error('OAuth callback error', e.message);
    res.status(500).send('Erro ao conectar Strava: ' + e.message);
  }
});

app.get('/api/status', (req, res) => {
  const s = getSession(req);
  if (s) serverSession = s;
  res.json({
    configured: !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET),
    connected: !!s,
    athlete: s?.athlete || null,
    autoRefreshMinutes: 5,
    backgroundReady: !!serverSession
  });
});

app.get('/api/activities', async (req, res) => {
  try {
    const s = await freshSession(req, res);
    if (!s) return res.status(401).json({ error: 'Strava not connected' });
    const force = req.query.force === '1';
    const result = await activitiesFor(s, force);
    res.json({ activities: result.data, syncedAt: new Date(result.at).toISOString(), cached: !force });
  } catch (e) {
    console.error('Activities error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/athlete-stats', async (req, res) => {
  try {
    const s = await freshSession(req, res);
    if (!s) return res.status(401).json({ error: 'Strava not connected' });
    const result = await statsFor(s, req.query.force === '1');
    res.json({ stats: result?.data || null, syncedAt: result ? new Date(result.at).toISOString() : null });
  } catch (e) {
    console.error('Stats error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const s = await freshSession(req, res);
    if (!s) return res.status(401).json({ error: 'Strava not connected' });
    await runBackgroundSync();
    const cached = activityCache.get(String(s.athlete?.id || 'me'));
    res.json({ ok: true, count: cached?.data?.length || 0, syncedAt: cached ? new Date(cached.at).toISOString() : null });
  } catch (e) {
    console.error('Manual sync error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/internal/sync', async (req, res) => {
  if (!process.env.INTERNAL_SYNC_SECRET || req.get('x-sync-secret') !== process.env.INTERNAL_SYNC_SECRET) return res.sendStatus(403);
  if (!serverSession) return res.status(409).json({ ok: false, reason: 'No active Strava session yet' });
  await runBackgroundSync();
  const cached = activityCache.get(String(serverSession.athlete?.id || 'me'));
  res.json({ ok: true, count: cached?.data?.length || 0, syncedAt: cached ? new Date(cached.at).toISOString() : null });
});

app.post('/api/disconnect', (req, res) => {
  const s = getSession(req);
  if (s?.athlete?.id) {
    activityCache.delete(String(s.athlete.id));
    statsCache.delete(String(s.athlete.id));
  }
  serverSession = null;
  res.setHeader('Set-Cookie', 'hm84_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({
  ok: true,
  stravaConfigured: !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET),
  cacheMinutes: CACHE_MS / 60000,
  backgroundReady: !!serverSession,
  backgroundSyncMinutes: BACKGROUND_SYNC_MS / 60000
}));

setInterval(runBackgroundSync, BACKGROUND_SYNC_MS).unref();
app.listen(PORT, '0.0.0.0', () => console.log(`HM84 ${PUBLIC_URL}`));
