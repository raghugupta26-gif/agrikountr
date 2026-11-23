/* Cloud backup to the dealer's own Google Drive.
   - The shop computer signs in once with Google (the browser opens; the answer comes back to this computer).
   - Every backup is locked with the shop's backup PIN (AES-256-GCM, key from scrypt) before it leaves the computer.
     Google and we cannot read it. Without the PIN nobody can open it.
   - Permission asked: drive.file only, so the app sees just the files it made itself.
   - Keeps the last 14 backups plus one per month for 12 months.
   - Restore on a new computer: sign in, pick a backup, type the PIN. */
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('KKB1');
const FOLDER = 'AgriKountr Backups';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCRYPT = {N:1<<17, r:8, p:1, maxmem:256*1024*1024};
const DAY = 24*3600e3;
const err = (msg, status=400, code) => Object.assign(new Error(msg), {status, code});

function deriveKey(pin, salt){ return crypto.scryptSync(String(pin), salt, 32, SCRYPT); }
function lock(obj, key, salt){
  const iv=crypto.randomBytes(12); const c=crypto.createCipheriv('aes-256-gcm', key, iv);
  const body=Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
}
function unlock(buf, pin, keyCache){
  if(buf.length<4+16+12+16 || !buf.subarray(0,4).equals(MAGIC)) throw err('This is not a AgriKountr backup.', 422);
  const salt=buf.subarray(4,20), iv=buf.subarray(20,32), tag=buf.subarray(buf.length-16), body=buf.subarray(32, buf.length-16);
  const key = keyCache && keyCache.salt.equals(salt) ? keyCache.key : deriveKey(pin, salt);
  try{ const d=crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); const out=Buffer.concat([d.update(body), d.final()]); return {data:JSON.parse(zlib.gunzipSync(out).toString('utf8')), key, salt:Buffer.from(salt)}; }
  catch(e){ throw err('Wrong PIN, or the backup file is damaged.', 422, 'bad_pin'); }
}

function loadClient(dir){
  const env = process.env.KK_GOOGLE_CLIENT_ID ? {clientId:process.env.KK_GOOGLE_CLIENT_ID, clientSecret:process.env.KK_GOOGLE_CLIENT_SECRET||''} : null;
  if(env) return env;
  try{ const j=JSON.parse(fs.readFileSync(path.join(dir,'google-oauth.json'),'utf8')); const c=j.installed||j; if(c.client_id||c.clientId) return {clientId:c.client_id||c.clientId, clientSecret:c.client_secret||c.clientSecret||''}; }catch(e){}
  return null;
}

/* opts: settings, saveSettings, snapshot() -> {store, settings to keep}, restoreInto(data), log, port, openUrl, google:{clientId,clientSecret}, endpoints (for tests) */
function makeCloud(opts){
  const {settings, saveSettings, log} = opts;
  const E = {auth:'https://accounts.google.com/o/oauth2/v2/auth', token:'https://oauth2.googleapis.com/token', revoke:'https://oauth2.googleapis.com/revoke',
    drive:'https://www.googleapis.com/drive/v3', upload:'https://www.googleapis.com/upload/drive/v3', ...(opts.endpoints||{})};
  const client = opts.google || loadClient(opts.clientDir || __dirname);
  const C = () => settings.cloud || (settings.cloud = {});
  let access=null, accessExp=0, pending=null, running=null;
  let keyCache=null;   // {key, salt} for the current PIN
  function key(){ const c=C(); if(!c.key||!c.salt) return null; if(!keyCache || keyCache.salt.toString('hex')!==c.salt) keyCache={key:Buffer.from(c.key,'hex'), salt:Buffer.from(c.salt,'hex')}; return keyCache; }

  function status(){
    const c=C(); const last=c.lastOk?Date.parse(c.lastOk):0;
    return {configured:!!client, connected:!!c.refresh, email:c.email||'', hasPin:!!c.key, lastOk:c.lastOk||'', lastTry:c.lastTry||'', lastError:c.lastError||'', lastSize:c.lastSize||0, count:c.count||0,
      safe: !!(c.refresh && c.key && last && Date.now()-last < 2*DAY), stale: !!(c.refresh && c.key && (!last || Date.now()-last >= 2*DAY)), signInNeeded: !!c.signInNeeded};
  }
  function setPin(pin, pin2){
    if(!/^\d{6,12}$/.test(String(pin||''))) throw err('PIN must be 6 to 12 digits.');
    if(pin2!==undefined && String(pin)!==String(pin2)) throw err('The two PINs are not the same.');
    const salt=crypto.randomBytes(16); const k=deriveKey(pin, salt);
    Object.assign(C(), {key:k.toString('hex'), salt:salt.toString('hex'), pinSetAt:new Date().toISOString()}); keyCache=null; saveSettings();
    return status();
  }

  /* ---------- Google sign-in (loopback + PKCE, the way Google asks desktop apps to do it) ---------- */
  const redirect = () => `http://127.0.0.1:${opts.port}/oauth/google`;
  function startSignIn(){
    if(!client) throw err('This copy of the app has no Google key yet.', 503);
    const verifier=crypto.randomBytes(32).toString('base64url'), state=crypto.randomBytes(16).toString('hex');
    pending={state, verifier, exp:Date.now()+15*60e3};
    const q=new URLSearchParams({client_id:client.clientId, redirect_uri:redirect(), response_type:'code', scope:SCOPE, access_type:'offline', prompt:'consent', state,
      code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method:'S256'});
    const url=`${E.auth}?${q}`;
    let opened=false; if(opts.openUrl){ try{ opts.openUrl(url); opened=true; }catch(e){} }
    return {url, opened};
  }
  async function form(url, params){
    const r=await fetch(url, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(params)});
    let j={}; try{ j=await r.json(); }catch(e){} return {ok:r.ok, status:r.status, j};
  }
  async function finishSignIn(q){
    if(q.get('error')) throw err(q.get('error')==='access_denied'?'Google sign-in was cancelled.':'Google said: '+q.get('error'));
    if(!pending || q.get('state')!==pending.state || Date.now()>pending.exp) throw err('This sign-in link is old. Start again from the app.');
    const v=pending.verifier; pending=null;
    const t=await form(E.token, {code:q.get('code')||'', client_id:client.clientId, client_secret:client.clientSecret, redirect_uri:redirect(), grant_type:'authorization_code', code_verifier:v});
    if(!t.ok || !t.j.access_token) throw err('Google sign-in did not finish: '+(t.j.error_description||t.j.error||t.status), 502);
    if(t.j.scope && !String(t.j.scope).includes('drive.file')) throw err('Please allow AgriKountr to save files in your Google Drive, then try again.', 403);
    const c=C(); if(t.j.refresh_token) c.refresh=t.j.refresh_token;
    if(!c.refresh) throw err('Google did not give a lasting sign-in. Remove AgriKountr at myaccount.google.com → Security → Third-party access, then try again.', 502);
    access=t.j.access_token; accessExp=Date.now()+((t.j.expires_in||3600)-120)*1000;
    try{ const me=await drive('GET', `/about?fields=user(emailAddress,displayName)`); c.email=(me.user&&me.user.emailAddress)||''; }catch(e){}
    c.signInNeeded=false; c.lastError=''; c.folder=''; saveSettings(); log('google drive connected', c.email);
    setTimeout(()=>auto(true), 500);
    return status();
  }
  async function token(){
    if(access && Date.now()<accessExp) return access;
    const c=C(); if(!c.refresh) throw err('Not signed in to Google.', 401, 'signin');
    const t=await form(E.token, {client_id:client.clientId, client_secret:client.clientSecret, refresh_token:c.refresh, grant_type:'refresh_token'});
    if(!t.ok){
      if(t.j.error==='invalid_grant'){ c.refresh=''; c.signInNeeded=true; saveSettings(); throw err('Google sign-in has expired. Sign in again.', 401, 'signin'); }
      throw err('Could not reach Google: '+(t.j.error||t.status), 502);
    }
    access=t.j.access_token; accessExp=Date.now()+((t.j.expires_in||3600)-120)*1000; return access;
  }
  async function drive(method, p, body, {raw=false, base=E.drive, headers={}}={}){
    const tok=await token();
    let r; try{ r=await fetch(base+p, {method, headers:{Authorization:'Bearer '+tok, ...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}), ...headers}, body: body? (Buffer.isBuffer(body)?body:JSON.stringify(body)) : undefined}); }
    catch(e){ throw err('No internet on this computer. The backup will be tried again later.', 503, 'offline'); }
    if(r.status===401){ access=null; }
    if(!r.ok){ let j={}; try{ j=await r.json(); }catch(e){} const m=(j.error&&(j.error.message||j.error))||r.status; const e=err('Google Drive: '+m, r.status===404?404:502); e.http=r.status; throw e; }
    if(raw) return r;
    if(r.status===204) return {};
    return r.json();
  }
  async function folder(){
    const c=C(); if(c.folder) return c.folder;
    const q=encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const l=await drive('GET', `/files?q=${q}&fields=files(id,name)&spaces=drive`);
    const id=(l.files&&l.files[0]&&l.files[0].id) || (await drive('POST', '/files?fields=id', {name:FOLDER, mimeType:'application/vnd.google-apps.folder', description:'Locked backups of the AgriKountr shop book. Opening them needs the shop backup PIN.'})).id;
    c.folder=id; saveSettings(); return id;
  }
  async function list(){
    const f=await folder(); const q=encodeURIComponent(`'${f}' in parents and trashed=false`);
    const l=await drive('GET', `/files?q=${q}&orderBy=createdTime desc&pageSize=200&fields=files(id,name,size,createdTime,appProperties)`);
    return (l.files||[]).filter(x=>/\.kkb$/.test(x.name)).map(x=>({id:x.id, name:x.name, size:Number(x.size)||0, at:(x.appProperties&&x.appProperties.at)||x.createdTime, shop:(x.appProperties&&x.appProperties.shop)||'', docs:Number(x.appProperties&&x.appProperties.docs)||0}));
  }

  /* ---------- back up ---------- */
  async function backup(){
    if(running) return running;
    running=(async()=>{
      const c=C(); c.lastTry=new Date().toISOString();
      try{
        const k=key(); if(!k) throw err('Set a backup PIN first.', 400, 'pin');
        const snap=opts.snapshot(); const at=new Date().toISOString();
        const buf=lock({v:1, at, ...snap}, k.key, k.salt);
        const slug=String(snap.shopName||'shop').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,30)||'shop';
        const meta={name:`agrikountr-${slug}-${at.slice(0,16).replace(/[:T]/g,'-')}.kkb`, mimeType:'application/octet-stream',
          appProperties:{kk:'1', at, shop:String(snap.shopName||'').slice(0,60), docs:String(Object.keys((snap.store&&snap.store.docs)||{}).length)}};
        const send=async()=>{
          meta.parents=[await folder()];
          const r=await drive('POST', '/files?uploadType=resumable&fields=id', meta, {raw:true, base:E.upload, headers:{'X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(buf.length)}});
          const loc=r.headers.get('location'); if(!loc) throw err('Google Drive did not accept the upload.', 502);
          let u; try{ u=await fetch(loc, {method:'PUT', headers:{'Content-Type':'application/octet-stream','Content-Length':String(buf.length)}, body:buf}); }catch(e){ throw err('No internet on this computer. The backup will be tried again later.', 503, 'offline'); }
          if(!u.ok) throw err('Upload to Google Drive failed ('+u.status+').', 502);
          return u.json();
        };
        let up; try{ up=await send(); }catch(e){ if(e.http===404){ c.folder=''; up=await send(); } else throw e; }   /* folder deleted in Drive: make it again */
        Object.assign(c, {lastOk:at, lastSize:buf.length, lastError:'', lastId:up.id}); saveSettings();
        try{ await prune(); }catch(e){ log('cloud prune', e.message); }
        log('cloud backup ok', buf.length, 'bytes'); return status();
      }catch(e){ c.lastError=e.message; saveSettings(); log('cloud backup failed', e.message); throw e; }
      finally{ running=null; }
    })();
    return running;
  }
  async function prune(){
    const all=await list(); C().count=all.length;
    const keep=new Set(all.slice(0,14).map(x=>x.id)); const months=new Set();
    for(const x of all.slice().reverse()){ const m=x.at.slice(0,7); if(!months.has(m) && Date.now()-Date.parse(x.at)<366*DAY){ months.add(m); keep.add(x.id); } }
    for(const x of all) if(!keep.has(x.id)){ try{ await drive('DELETE', `/files/${x.id}`); }catch(e){} }
    C().count=all.filter(x=>keep.has(x.id)).length; saveSettings();
  }
  /* called often; backs up when the last good one is old. force = right after sign-in or "back up now" */
  async function auto(force){
    const c=C(); if(!client || !c.refresh || !c.key) return;
    const last=c.lastOk?Date.parse(c.lastOk):0, tried=c.lastTry?Date.parse(c.lastTry):0;
    if(!force && Date.now()-last<20*3600e3) return;
    if(!force && c.lastError && Date.now()-tried<30*60e3) return;   /* failed recently: wait a bit */
    try{ await backup(); }catch(e){}
  }

  /* ---------- restore ---------- */
  async function restore(id, pin){
    if(!/^[A-Za-z0-9_-]{10,}$/.test(String(id||''))) throw err('Pick a backup.');
    const r=await drive('GET', `/files/${id}?alt=media`, null, {raw:true});
    const buf=Buffer.from(await r.arrayBuffer());
    const {data, key:k, salt}=unlock(buf, pin);
    if(!data || !data.store || typeof data.store.docs!=='object') throw err('This backup has no shop data.', 422);
    opts.restoreInto(data);
    Object.assign(C(), {key:k.toString('hex'), salt:salt.toString('hex'), restoredFrom:data.at}); keyCache=null; saveSettings();
    log('restored from cloud backup of', data.at);
    return {ok:true, at:data.at, docs:Object.keys(data.store.docs).length};
  }
  async function disconnect(){
    const c=C(); const t=c.refresh;
    if(t){ try{ await form(E.revoke, {token:t}); }catch(e){} }
    for(const k of ['refresh','email','folder','lastError','signInNeeded']) delete c[k]; access=null; saveSettings(); return status();
  }
  return {status, setPin, startSignIn, finishSignIn, backup, auto, list, restore, disconnect, _lock:lock, _unlock:unlock};
}
module.exports = { makeCloud, lock, unlock, deriveKey };
