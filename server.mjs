import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';

const {Pool}=pg;
const app=express();
const PORT=process.env.PORT||3000;
const API_BASE=process.env.STRAVA_API_BASE||'https://www.strava.com/api/v3';
const publicUrl=()=> (process.env.RENDER_EXTERNAL_URL||process.env.PUBLIC_URL||`http://localhost:${PORT}`).replace(/\/$/,'');
const pool=process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}}) : null;

app.use(express.json());
app.use(express.static('public'));

async function initDb(){
 if(!pool) return;
 await pool.query(`
 CREATE TABLE IF NOT EXISTS strava_auth(
 athlete_id BIGINT PRIMARY KEY,access_token TEXT NOT NULL,refresh_token TEXT NOT NULL,
 expires_at BIGINT NOT NULL,scope TEXT,athlete JSONB,updated_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS activities(
 id BIGINT PRIMARY KEY,athlete_id BIGINT NOT NULL,name TEXT,sport_type TEXT,start_date TIMESTAMPTZ,
 distance DOUBLE PRECISION,moving_time INTEGER,elapsed_time INTEGER,total_elevation_gain DOUBLE PRECISION,
 average_speed DOUBLE PRECISION,max_speed DOUBLE PRECISION,average_heartrate DOUBLE PRECISION,
 max_heartrate DOUBLE PRECISION,average_cadence DOUBLE PRECISION,suffer_score DOUBLE PRECISION,
 raw JSONB,updated_at TIMESTAMPTZ DEFAULT NOW());`);
}

function cookie(req,key){
 const out={};
 for(const part of (req.headers.cookie||'').split(';')){
  const i=part.indexOf('=');
  if(i>0) out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
 }
 return out[key];
}

async function tokenRequest(body){
 const r=await fetch('https://www.strava.com/oauth/token',{
  method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
 if(!r.ok) throw new Error(`Token ${r.status}: ${await r.text()}`);
 return r.json();
}

async function authRow(id=null){
 if(!pool) return null;
 const q=id?await pool.query('SELECT * FROM strava_auth WHERE athlete_id=$1 LIMIT 1',[id])
           :await pool.query('SELECT * FROM strava_auth ORDER BY updated_at DESC LIMIT 1');
 return q.rows[0]||null;
}

async function saveAuth(t){
 if(!pool) throw new Error('Banco de dados ainda não configurado');
 const a=t.athlete||{};
 await pool.query(`INSERT INTO strava_auth(athlete_id,access_token,refresh_token,expires_at,scope,athlete,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,NOW())
 ON CONFLICT(athlete_id) DO UPDATE SET access_token=EXCLUDED.access_token,refresh_token=EXCLUDED.refresh_token,
 expires_at=EXCLUDED.expires_at,scope=EXCLUDED.scope,athlete=COALESCE(EXCLUDED.athlete,strava_auth.athlete),updated_at=NOW()`,
 [a.id,t.access_token,t.refresh_token,t.expires_at,t.scope||'',JSON.stringify(a)]);
}

async function validToken(id=null){
 const row=await authRow(id); if(!row) return null;
 if(Number(row.expires_at)>Math.floor(Date.now()/1000)+3600) return row.access_token;
 const t=await tokenRequest({client_id:process.env.STRAVA_CLIENT_ID,client_secret:process.env.STRAVA_CLIENT_SECRET,
  grant_type:'refresh_token',refresh_token:row.refresh_token});
 await pool.query('UPDATE strava_auth SET access_token=$1,refresh_token=$2,expires_at=$3,updated_at=NOW() WHERE athlete_id=$4',
  [t.access_token,t.refresh_token,t.expires_at,row.athlete_id]);
 return t.access_token;
}

async function sget(path,id=null){
 const tok=await validToken(id); if(!tok) throw new Error('Strava not connected');
 const r=await fetch(API_BASE+path,{headers:{Authorization:`Bearer ${tok}`}});
 if(!r.ok) throw new Error(`Strava ${r.status}: ${await r.text()}`);
 return r.json();
}

async function upsert(a){
 if(!pool) throw new Error('Banco de dados ainda não configurado');
 await pool.query(`INSERT INTO activities(id,athlete_id,name,sport_type,start_date,distance,moving_time,elapsed_time,
 total_elevation_gain,average_speed,max_speed,average_heartrate,max_heartrate,average_cadence,suffer_score,raw,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
 ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sport_type=EXCLUDED.sport_type,start_date=EXCLUDED.start_date,
 distance=EXCLUDED.distance,moving_time=EXCLUDED.moving_time,elapsed_time=EXCLUDED.elapsed_time,
 total_elevation_gain=EXCLUDED.total_elevation_gain,average_speed=EXCLUDED.average_speed,max_speed=EXCLUDED.max_speed,
 average_heartrate=EXCLUDED.average_heartrate,max_heartrate=EXCLUDED.max_heartrate,average_cadence=EXCLUDED.average_cadence,
 suffer_score=EXCLUDED.suffer_score,raw=EXCLUDED.raw,updated_at=NOW()`,
 [a.id,a.athlete?.id,a.name,a.sport_type||a.type,a.start_date,a.distance,a.moving_time,a.elapsed_time,a.total_elevation_gain,
  a.average_speed,a.max_speed,a.average_heartrate,a.max_heartrate,a.average_cadence,a.suffer_score,JSON.stringify(a)]);
}

async function syncRecent(){
 const ar=await authRow(); if(!ar) throw new Error('Strava not connected');
 const list=await sget('/athlete/activities?per_page=50&page=1',ar.athlete_id);
 for(const a of list) await upsert(a);
 return list.length;
}

async function ensureWebhook(){
 const cid=process.env.STRAVA_CLIENT_ID, cs=process.env.STRAVA_CLIENT_SECRET; if(!cid||!cs) return;
 const qs=new URLSearchParams({client_id:cid,client_secret:cs});
 let r=await fetch(`${API_BASE}/push_subscriptions?${qs}`);
 if(r.ok){const x=await r.json(); if(Array.isArray(x)&&x.length) return;}
 const form=new URLSearchParams({client_id:cid,client_secret:cs,callback_url:`${publicUrl()}/webhook`,
 verify_token:process.env.STRAVA_VERIFY_TOKEN||'hm84'});
 r=await fetch(`${API_BASE}/push_subscriptions`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});
 if(!r.ok) console.error('Webhook:',await r.text());
}

app.get('/auth/strava',(req,res)=>{
 if(!process.env.STRAVA_CLIENT_ID || !pool) return res.status(503).send('Integração Strava ainda não configurada.');
 const state=crypto.randomBytes(18).toString('hex');
 res.setHeader('Set-Cookie',`hm84_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
 const p=new URLSearchParams({client_id:process.env.STRAVA_CLIENT_ID,response_type:'code',
 redirect_uri:`${publicUrl()}/auth/strava/callback`,approval_prompt:'auto',scope:'read,activity:read_all',state});
 res.redirect(`https://www.strava.com/oauth/authorize?${p}`);
});

app.get('/auth/strava/callback',async(req,res)=>{
 try{
  if(req.query.error) return res.redirect('/?strava=denied');
  if(!req.query.code||req.query.state!==cookie(req,'hm84_oauth_state')) return res.status(400).send('OAuth state invalid');
  const t=await tokenRequest({client_id:process.env.STRAVA_CLIENT_ID,client_secret:process.env.STRAVA_CLIENT_SECRET,
   code:req.query.code,grant_type:'authorization_code'});
  await saveAuth(t); await syncRecent(); await ensureWebhook(); res.redirect('/?strava=connected');
 }catch(e){console.error(e);res.status(500).send('Strava connection failed: '+e.message)}
});

app.get('/api/status',async(req,res)=>{const r=await authRow();res.json({connected:!!r,configured:!!process.env.STRAVA_CLIENT_ID&&!!pool,database:!!pool,athlete:r?.athlete||null})});
app.get('/api/activities',async(req,res)=>{
 if(!pool) return res.json([]);
 const {rows}=await pool.query(`SELECT id,name,sport_type,start_date,distance,moving_time,elapsed_time,total_elevation_gain,
 average_speed,max_speed,average_heartrate,max_heartrate,average_cadence,suffer_score FROM activities ORDER BY start_date DESC LIMIT 100`);
 res.json(rows);
});
app.post('/api/sync',async(req,res)=>{try{res.json({ok:true,count:await syncRecent()})}catch(e){res.status(400).json({ok:false,error:e.message})}});

app.get('/webhook',(req,res)=>{
 if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===(process.env.STRAVA_VERIFY_TOKEN||'hm84'))
  return res.json({'hub.challenge':req.query['hub.challenge']});
 res.sendStatus(403);
});

app.post('/webhook',(req,res)=>{
 const ev=req.body; res.sendStatus(200);
 setImmediate(async()=>{try{
  if(ev.object_type==='activity'){
   if(ev.aspect_type==='delete' && pool) await pool.query('DELETE FROM activities WHERE id=$1',[ev.object_id]);
   else if(await authRow(ev.owner_id)) await upsert(await sget(`/activities/${ev.object_id}`,ev.owner_id));
  }else if(ev.object_type==='athlete'&&ev.updates?.authorized==='false' && pool)
   await pool.query('DELETE FROM strava_auth WHERE athlete_id=$1',[ev.owner_id]);
 }catch(e){console.error('webhook',e)}});
});
app.get('/health',(req,res)=>res.json({ok:true,database:!!pool}));

initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log('HM84 '+publicUrl()))).catch(e=>{console.error(e);process.exit(1)});
