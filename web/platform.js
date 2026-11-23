/* AgriKountr platform layer.
   Gives the app the same `claude.use(...)` services it had in the prototype, but runs on its own:
   - db:       local store on this device (IndexedDB) + sync with the shop computer over Wi-Fi
   - user:     this device and its role (owner / staff)
   - sample:   AI bill reading through the shop computer (or directly, in phone-only mode)
   - tts / dictation: phone or computer voice in Telugu
   - downloads: save a file (Excel, backup)
   - room:     which phones and computers are connected now
*/
(function(){
'use strict';
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const PLUG = () => (window.Capacitor && window.Capacitor.Plugins) || {};
const CFG_KEY = 'kk_cfg_v1';
const rid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);

/* ---------- config: who am I, where is the shop computer ---------- */
let cfg = {};
try{ cfg = JSON.parse(localStorage.getItem(CFG_KEY)||'{}'); }catch(e){ cfg={}; }
if(!cfg.deviceId){ cfg.deviceId = 'd_'+rid(); }
function saveCfg(){ try{ localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }catch(e){} }
saveCfg();

/* mode: 'desktop' = this IS the shop computer (served by the local server)
         'paired'  = phone linked to a shop computer
         'alone'   = phone used without a computer
         'new'     = phone not set up yet */
let MODE = 'new';
let BASE = '';            // server address, e.g. http://192.168.1.20:8765
async function detectMode(){
  if(!IS_NATIVE && /^https?:$/.test(location.protocol)){
    try{
      const r = await fetch('/api/info', {cache:'no-store'});
      if(r.ok){ const j = await r.json(); if(j && j.app==='agrikountr'){
        BASE = location.origin;
        if(j.local){ MODE='desktop'; cfg.role='owner'; cfg.token='local'; cfg.shopName=j.shopName||''; saveCfg(); return; }
        if(cfg.token && cfg.server===BASE){ MODE='paired'; return; }
        MODE='new'; return; } }
    }catch(e){}
  }
  if(cfg.server && cfg.token){ MODE='paired'; BASE=cfg.server; return; }
  if(cfg.alone){ MODE='alone'; return; }
  MODE='new';
}

/* ---------- local store (IndexedDB, falls back to memory) ---------- */
const docs = new Map();         // path -> data
let pending = [];                // [{path, data|null, ts}]
let cursor = 0;
let idb = null;
function idbOpen(){ return new Promise(res=>{ try{ const q=indexedDB.open('agrikountr',1); q.onupgradeneeded=()=>{ q.result.createObjectStore('docs'); q.result.createObjectStore('meta'); }; q.onsuccess=()=>res(q.result); q.onerror=()=>res(null); }catch(e){ res(null); } }); }
function idbAll(store){ return new Promise(res=>{ if(!idb) return res([]); const out=[]; const tx=idb.transaction(store,'readonly'); const c=tx.objectStore(store).openCursor(); c.onsuccess=()=>{ const cur=c.result; if(cur){ out.push([cur.key, cur.value]); cur.continue(); } else res(out); }; c.onerror=()=>res(out); }); }
function idbPut(store, key, val){ if(!idb) return; try{ const tx=idb.transaction(store,'readwrite'); if(val===undefined) tx.objectStore(store).delete(key); else tx.objectStore(store).put(val, key); }catch(e){} }
async function loadStore(){
  idb = await idbOpen();
  for(const [k,v] of await idbAll('docs')) docs.set(k, v);
  for(const [k,v] of await idbAll('meta')){ if(k==='pending') pending=v||[]; if(k==='cursor') cursor=v||0; }
}
const saveMeta = () => { idbPut('meta','pending',pending); idbPut('meta','cursor',cursor); };
/* after a restore on the shop computer: forget this screen's copy and fetch everything again */
function resetLocal(){ docs.clear(); pending=[]; cursor=0; return new Promise(res=>{ if(!idb) return res(); try{ const tx=idb.transaction(['docs','meta'],'readwrite'); tx.objectStore('docs').clear(); tx.objectStore('meta').clear(); tx.oncomplete=()=>res(); tx.onerror=()=>res(); }catch(e){ res(); } }); }

/* ---------- listeners ---------- */
const docL = new Map(), colL = new Map();
const parentOf = p => p.split('/').slice(0,-1).join('/');
const segs = p => p.split('/').filter(Boolean).length;
function snapDoc(path){ const d=docs.get(path); const id=path.split('/').pop(); return {id, exists:d!==undefined, data:()=>d===undefined?undefined:JSON.parse(JSON.stringify(d)), metadata:{fromCache:false, hasPendingWrites:pending.some(x=>x.path===path)}}; }
function snapCol(cp){ const list=[]; for(const k of docs.keys()){ if(parentOf(k)===cp) list.push(snapDoc(k)); } list.sort((a,b)=>a.id<b.id?-1:1); return {docs:list, size:list.length, empty:!list.length, docChanges:()=>[], metadata:{fromCache:false, hasPendingWrites:false}}; }
const dirty = new Set(); let flushT=null;
function notify(path){ dirty.add(path); if(!flushT) flushT=setTimeout(flush, 30); }
function flush(){ flushT=null; const ps=[...dirty]; dirty.clear(); const cols=new Set();
  for(const p of ps){ (docL.get(p)||[]).forEach(fn=>{ try{ fn(snapDoc(p)); }catch(e){ console.error(e); } }); cols.add(parentOf(p)); }
  for(const c of cols){ (colL.get(c)||[]).forEach(fn=>{ try{ fn(snapCol(c)); }catch(e){ console.error(e); } }); } }
function writeLocal(path, data, fromServer){
  const prev = docs.get(path);
  if(data===null){ docs.delete(path); idbPut('docs', path, undefined); } else { docs.set(path, data); idbPut('docs', path, data); }
  if(!fromServer){
    /* stock and dues travel as changes (−1 bag, +₹500), so two devices working offline never overwrite each other */
    const old = pending.find(x=>x.path===path);
    const ch = {path, data, ts:Date.now(), dev:cfg.deviceId};
    if(data && prev){
      if(/\/products\/[^/]+$/.test(path)){ const inc={...((old&&old.inc&&old.inc.loc)||{})}; const a=prev.loc||{}, b=data.loc||{}; for(const k of new Set([...Object.keys(a),...Object.keys(b)])){ const d=(Number(b[k])||0)-(Number(a[k])||0); if(d) inc[k]=(inc[k]||0)+d; } ch.inc={loc:inc}; }
      if(/\/parties\/[^/]+$/.test(path)){ const d=(Number(data.due)||0)-(Number(prev.due)||0); ch.inc={due:((old&&old.inc&&old.inc.due)||0)+d};
        const key=h=>[h.t,h.type,h.amt].join('|'); const had=new Set((prev.hist||[]).map(key)); ch.histAdd=[...((old&&old.histAdd)||[]), ...(data.hist||[]).filter(h=>!had.has(key(h)))]; }
    } else if(old && old.inc && data){ ch.inc=old.inc; ch.histAdd=old.histAdd; }
    pending = pending.filter(x=>x.path!==path); pending.push(ch); saveMeta(); kick();
  }
  notify(path);
}

/* ---------- db API (same shape the app already uses) ---------- */
function DocRef(path){
  if(segs(path)%2) throw new TypeError('document path needs an even number of segments: '+path);
  return { id:path.split('/').pop(), path,
    get: async()=>snapDoc(path),
    set: async(d)=>{ writeLocal(path, JSON.parse(JSON.stringify(d||{}))); },
    update: async(d)=>{ const cur=docs.get(path); if(cur===undefined) throw {code:'invalid_argument', message:'document does not exist'}; writeLocal(path, deepMerge(JSON.parse(JSON.stringify(cur)), d)); },
    delete: async()=>{ writeLocal(path, null); },
    acquire: async()=>({acquired:true}),
    onSnapshot(next, err){ if(!docL.has(path)) docL.set(path,new Set()); docL.get(path).add(next); setTimeout(()=>next(snapDoc(path)),0); return ()=>docL.get(path).delete(next); },
    collection: (name)=>ColRef(path+'/'+name)
  };
}
function deepMerge(a,b){ for(const k in b){ if(b[k] && typeof b[k]==='object' && !Array.isArray(b[k]) && a[k] && typeof a[k]==='object') a[k]=deepMerge(a[k],b[k]); else a[k]=b[k]; } return a; }
function ColRef(path){
  if(!(segs(path)%2)) throw new TypeError('collection path needs an odd number of segments: '+path);
  const q = { path,
    doc: (id)=>DocRef(path+'/'+(id||rid())),
    add: async(d)=>{ const r=DocRef(path+'/'+rid()); await r.set(d); return r; },
    where: ()=>q, orderBy: ()=>q, limit: ()=>q,
    get: async()=>snapCol(path),
    onSnapshot(next){ if(!colL.has(path)) colL.set(path,new Set()); colL.get(path).add(next); setTimeout(()=>next(snapCol(path)),0); return ()=>colL.get(path).delete(next); }
  };
  return q;
}
const db = { doc:DocRef, collection:ColRef };

/* ---------- sync with the shop computer ---------- */
let online=false, syncing=false, kickT=null, es=null, lastOk=0;
const statusL = new Set();
function setOnline(v){ if(v!==online){ online=v; statusL.forEach(f=>{ try{ f(v); }catch(e){} }); } }
function headers(){ return {'Content-Type':'application/json', 'X-KK-Token':cfg.token||'', 'X-KK-Device':cfg.deviceId}; }
async function api(path, opts={}){
  const ctl = new AbortController(); const t=setTimeout(()=>ctl.abort(), opts.timeout||15000);
  try{ const r = await fetch(BASE+path, {...opts, headers:{...headers(), ...(opts.headers||{})}, signal:ctl.signal}); clearTimeout(t);
    if(r.status===401){ if(MODE==='paired'){ setOnline(false); KK.needsPairing=true; } throw {code:'unauthorized'}; }
    if(!r.ok) throw {code:'http_'+r.status, message:await r.text().catch(()=>'')};
    return await r.json(); } finally { clearTimeout(t); }
}
function kick(){ if(MODE!=='paired' && MODE!=='desktop') return; clearTimeout(kickT); kickT=setTimeout(syncNow, 150); }
async function syncNow(){
  if(syncing || (MODE!=='paired' && MODE!=='desktop')) return; syncing=true;
  try{
    if(pending.length){
      const batch = pending.slice(0, 50);
      const r = await api('/api/sync', {method:'POST', body:JSON.stringify({changes:batch}), timeout:60000});
      const sent = new Set(batch.map(x=>x.path+'|'+x.ts));
      pending = pending.filter(x=>!sent.has(x.path+'|'+x.ts)); saveMeta();
      if(r && r.rejected && r.rejected.length) console.warn('rejected', r.rejected);
    }
    for(let i=0;i<20;i++){
      const r = await api('/api/sync?since='+cursor+'&limit=500');
      for(const c of r.changes||[]){ if(pending.some(p=>p.path===c.path)) continue; writeLocal(c.path, c.data, true); }
      cursor = r.seq||cursor; saveMeta();
      if(!r.more) break;
    }
    lastOk=Date.now(); setOnline(true);
    if(pending.length) kick();
  }catch(e){ setOnline(false); }
  finally{ syncing=false; }
}
function startLive(){
  if(MODE!=='paired' && MODE!=='desktop') return;
  try{ if(es) es.close(); es = new EventSource(BASE+'/api/events?t='+encodeURIComponent(cfg.token||'')+'&d='+encodeURIComponent(cfg.deviceId));
    es.addEventListener('change', ()=>kick());
    es.addEventListener('peers', ev=>{ try{ setPeers(JSON.parse(ev.data)); }catch(e){} });
    es.onerror=()=>{ setOnline(false); };
    es.onopen=()=>{ kick(); };
  }catch(e){}
  setInterval(()=>{ kick(); }, 8000);  // also catches up if the live channel drops
}

/* ---------- presence (room) ---------- */
let peers = []; const peerL = new Set(); let myPresence = {};
function setPeers(list){ peers = (list||[]).map(p=>({peer:p.device, by:p.device, isMe:p.device===cfg.deviceId, sameTab:p.device===cfg.deviceId, kind:'viewer', guest:false, presence:p.presence||{}, updatedAt:Date.now()})); peerL.forEach(f=>{ try{ f({peers, joined:[], left:[], updated:[]}); }catch(e){} }); }
async function sendPresence(){ if(MODE!=='paired'&&MODE!=='desktop') return; try{ const r=await api('/api/presence',{method:'POST', body:JSON.stringify({presence:myPresence, name:cfg.deviceName||''}), timeout:5000}); if(r&&r.peers) setPeers(r.peers); }catch(e){} }
const room = {
  presence: async(patch)=>{ myPresence={...myPresence, ...patch}; for(const k in patch) if(patch[k]===null) delete myPresence[k]; clearTimeout(room._t); room._t=setTimeout(sendPresence, 300); },
  onPeers: (fn)=>{ peerL.add(fn); setTimeout(()=>fn({peers, joined:peers, left:[], updated:[]}),0); return ()=>peerL.delete(fn); },
  peers: ()=>peers, on: ()=>()=>{}, emit: async()=>{}, connected: ()=>online, onConnection: (fn)=>{ statusL.add(fn); setTimeout(()=>fn(online),0); return ()=>statusL.delete(fn); },
  canSendToClaudeSession: async()=>'off'
};
setInterval(()=>sendPresence(), 20000);

/* ---------- AI (bill reading, advice) ---------- */
const blobToB64 = b => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(',')[1]); r.onerror=rej; r.readAsDataURL(b); });
function parseJSON(t){ t=String(t||''); const a=t.indexOf('{'), b=t.lastIndexOf('}'); if(a<0||b<a) throw new Error('no json'); return JSON.parse(t.slice(a,b+1)); }
async function callAI(input, opts={}){
  const prompt = typeof input==='string' ? input : (input||[]).map(m=>m.content).join('\n\n');
  const images = [];
  for(const b of (opts.images||[])) images.push({media_type:b.type||'image/jpeg', data:await blobToB64(b)});
  const body = {prompt, images, tier:opts.modelTier||'default'};
  if(MODE==='paired' || MODE==='desktop'){
    const r = await api('/api/ai', {method:'POST', body:JSON.stringify(body), timeout:180000}).catch(e=>{ throw e && e.code==='http_429'?{code:'rate_limited'}:(e&&e.code==='http_503'?{code:'none', message:'AI key not set on the shop computer'}:{code:'offline'}); });
    return {text:r.text, truncated:false};
  }
  if(MODE==='alone' && cfg.aiKey){ const text = await directAI(body); return {text, truncated:false}; }
  throw {code:'none'};
}
const MODELS = {quick:'claude-haiku-5-5', default:'claude-sonnet-5-5', complex:'claude-opus-5-5'};
async function directAI({prompt, images, tier}){
  const content = [...images.map(i=>({type:'image', source:{type:'base64', media_type:i.media_type, data:i.data}})), {type:'text', text:prompt}];
  const r = await fetch('https://api.anthropic.com/v1/messages', {method:'POST', headers:{'content-type':'application/json','x-api-key':cfg.aiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:(cfg.models&&cfg.models[tier])||MODELS[tier]||MODELS.default, max_tokens:4096, messages:[{role:'user', content}]})});
  if(r.status===429) throw {code:'rate_limited'};
  if(!r.ok) throw {code:'error', message:await r.text()};
  const j = await r.json(); return (j.content||[]).map(c=>c.text||'').join('');
}
const sample = Object.assign((input, opts)=>callAI(input, opts), {
  json: async(input, opts)=>parseJSON((await callAI(input, opts)).text),
  limits: async()=>({images:true})
});

/* ---------- voice ---------- */
const tts = {
  speak: async(text, o={})=>{
    const lang = (o.language==='te'||!o.language)?'te-IN':o.language;
    const P = PLUG();
    if(P.TextToSpeech){ await P.TextToSpeech.speak({text:String(text).slice(0,3000), lang, rate:1.0}); return; }
    if(window.speechSynthesis){ return new Promise((res)=>{ const u=new SpeechSynthesisUtterance(text); u.lang=lang; const v=speechSynthesis.getVoices().find(v=>v.lang&&v.lang.startsWith(lang.slice(0,2))); if(v) u.voice=v; u.onend=res; u.onerror=res; speechSynthesis.cancel(); speechSynthesis.speak(u); }); }
    throw {code:'unavailable'};
  },
  stop: ()=>{ try{ const P=PLUG(); if(P.TextToSpeech) P.TextToSpeech.stop(); else speechSynthesis.cancel(); }catch(e){} },
  onState: ()=>()=>{}
};
function makeDictation(){
  const P = PLUG(); const finals=new Set(), states=new Set();
  const fire = (set, v)=>set.forEach(f=>{ try{ f(v); }catch(e){} });
  if(P.SpeechRecognition){
    return { onFinal:f=>{finals.add(f);}, onPartial:()=>{}, onState:f=>{states.add(f);},
      start: async()=>{ try{ const perm=await P.SpeechRecognition.requestPermissions?.(); fire(states,{state:'listening'});
        const r=await P.SpeechRecognition.start({language:'te-IN', maxResults:1, partialResults:false, popup:true});
        const t=(r&&r.matches&&r.matches[0])||''; if(t) fire(finals,{text:t}); fire(states,{state:'idle', reason:'stopped'}); }catch(e){ fire(states,{state:'idle', reason:'error'}); throw {code:'dismissed'}; } },
      stop: async()=>{ try{ await P.SpeechRecognition.stop(); }catch(e){} } };
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return null;
  let rec=null;
  return { onFinal:f=>{finals.add(f);}, onPartial:()=>{}, onState:f=>{states.add(f);},
    start: ()=>new Promise((res,rej)=>{ try{ rec=new SR(); rec.lang='te-IN'; rec.interimResults=false; rec.continuous=false;
      rec.onresult=e=>{ for(const r of e.results) if(r.isFinal) fire(finals,{text:r[0].transcript}); };
      rec.onend=()=>fire(states,{state:'idle', reason:'stopped'}); rec.onerror=()=>fire(states,{state:'idle', reason:'error'});
      rec.start(); fire(states,{state:'listening'}); res(); }catch(e){ rej({code:'dismissed'}); } }),
    stop: async()=>{ try{ rec&&rec.stop(); }catch(e){} } };
}

/* ---------- downloads ---------- */
const downloads = { save: async({filename, data})=>{
  const blob = data instanceof Blob ? data : new Blob([data]);
  const P = PLUG();
  if(IS_NATIVE && P.Filesystem){
    const b64 = await blobToB64(blob);
    const w = await P.Filesystem.writeFile({path:filename, data:b64, directory:'DOCUMENTS', recursive:true});
    if(P.Share){ try{ await P.Share.share({title:filename, url:w.uri}); }catch(e){} }
    return {status:'saved'};
  }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return {status:'saved'};
} };

/* ---------- user ---------- */
const user = {
  id: async()=>cfg.deviceId,
  me: async()=>({id:cfg.deviceId, name:cfg.deviceName||''}),
  isOwner: ()=>cfg.role!=='staff',
  canEdit: ()=>cfg.role!=='staff',
  can: ()=>true,
  profiles: async(ids)=>{ const out={}; let names={}; try{ if(MODE==='paired'||MODE==='desktop') names=(await api('/api/devices')).names||{}; }catch(e){} for(const id of ids) out[id]={id, name:names[id]||''}; return out; },
  search: async()=>[]
};

/* ---------- on-device checker (OCR on the shop computer) ---------- */
async function ocr(blob){
  if(MODE!=='paired' && MODE!=='desktop') return null;
  const data = await blobToB64(blob);
  return api('/api/ocr', {method:'POST', body:JSON.stringify({image:data}), timeout:120000});
}

/* ---------- public entry point the app calls ---------- */
let ready = null;
function init(){ if(!ready) ready=(async()=>{ await loadStore(); await detectMode(); if(MODE==='paired'||MODE==='desktop'){ startLive(); syncNow(); sendPresence(); }
  if(MODE==='paired' && !cfg.devCode){ try{ const j=await api('/api/me', {timeout:4000}); if(j&&j.code){ cfg.devCode=j.code; saveCfg(); } }catch(e){} } })(); return ready; }

/* ---------- e-way bills through the shop computer (login details stay there) ---------- */
async function ewbCall(path, body){
  if(MODE!=='paired' && MODE!=='desktop') throw {message:'This needs the shop computer. Use the portal file on this phone.'};
  try{ return await api(path, body===undefined?{}:{method:'POST', body:JSON.stringify(body), timeout:60000}); }
  catch(e){
    let m=e&&e.message; try{ const j=JSON.parse(m); m=j.error||m; }catch(x){}
    if(e&&e.code==='unauthorized') m='This phone is not connected to the shop computer.';
    else if(e&&(e.name==='AbortError'||e.name==='TypeError'||!m)) m=online?'The shop computer did not answer in time. Try again.':'Shop computer not reachable. Come to the shop Wi-Fi, or use the portal file.';
    throw {message:m};
  }
}
const ewbApi = {
  status: ()=> (MODE==='paired'||MODE==='desktop') ? api('/api/ewb/status',{timeout:5000}).catch(()=>({ready:false})) : Promise.resolve({ready:false}),
  generate: p=>ewbCall('/api/ewb/generate', {payload:p}),
  cancel: b=>ewbCall('/api/ewb/cancel', b),
  vehicle: b=>ewbCall('/api/ewb/vehicle', b),
  setup: b=>ewbCall('/api/ewb/setup', b),
  test: ()=>ewbCall('/api/ewb/test', {})
};
window.claude = { use: async(name)=>{
  await init();
  if(MODE==='new') return name==='tts'?tts:(name==='dictation'?makeDictation():(name==='downloads'?downloads:(name==='db'?db:(name==='user'?user:null))));
  switch(name){
    case 'db': return db; case 'user': return user; case 'sample': return (MODE==='alone'&&!cfg.aiKey)?null:sample;
    case 'tts': return tts; case 'dictation': return makeDictation(); case 'downloads': return downloads; case 'room': return room;
    default: return null;
  }
}};

/* ---------- pairing and settings screen (outside the app's own screens) ---------- */
const KK = window.KK = { get mode(){ return MODE; }, get online(){ return online; }, get devCode(){ return MODE==='paired'?(cfg.devCode||''):''; }, cfg, cloud:{ status:()=> (MODE==='paired'||MODE==='desktop') ? api('/api/cloud/status',{timeout:5000}).catch(()=>null) : Promise.resolve(null) }, ocr, syncNow, open:openLink, ewb:ewbApi, needsPairing:false };
function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }
function closeLink(){ const o=document.getElementById('kkLink'); if(o){ o.remove(); try{ window.dispatchEvent(new Event('kk-panel-closed')); }catch(e){} } }
async function openLink(){
  await init(); closeLink();
  const box = el(`<div id="kkLink" class="overlay" style="z-index:50"><div class="sheet" role="dialog" aria-modal="true" style="gap:12px"></div></div>`);
  document.body.appendChild(box); const s=box.firstChild;
  box.addEventListener('click', e=>{ if(e.target===box && MODE!=='new') closeLink(); });
  if(MODE==='desktop') return desktopPanel(s);
  if(MODE==='paired'){
    s.innerHTML = `<h2>కనెక్షన్ · Connection</h2><p>${online?'✅ షాప్ కంప్యూటర్‌తో కలిసి ఉంది · Connected to the shop computer':'⏳ షాప్ కంప్యూటర్ దొరకలేదు · Shop computer not reachable. Entries are saved on this phone and will sync when you are back on the shop Wi-Fi.'}</p>
      <p class="note">Computer: ${esc(cfg.server)} · Shop: ${esc(cfg.shopName||'')} · This phone: ${esc(cfg.deviceName||'')} (${cfg.role==='staff'?'staff':'owner'}) · Waiting to send: ${pending.length}</p>
      <button class="act green" id="kkSync">ఇప్పుడు సింక్ · Sync now</button>
      <button class="act ghost" id="kkRe">మళ్లీ కనెక్ట్ · Connect to a different computer</button>
      <button class="act ghost" id="kkX">మూసివేయండి · Close</button>`;
    s.querySelector('#kkSync').onclick=async()=>{ await syncNow(); openLink(); };
    s.querySelector('#kkRe').onclick=()=>{ cfg.server=''; cfg.token=''; saveCfg(); MODE='new'; openLink(); };
    s.querySelector('#kkX').onclick=closeLink; return;
  }
  if(MODE==='alone'){
    s.innerHTML = `<h2>ఈ ఫోన్ ఒక్కటే · This phone only</h2><p class="note">Data is kept on this phone. Add an AI key to read bill photos without a computer.</p>
      <label class="f">AI key<input id="kkKey" value="${esc(cfg.aiKey||'')}" placeholder="sk-ant-..."></label>
      <button class="act green" id="kkSave">సేవ్ · Save</button>
      <button class="act ghost" id="kkPair">షాప్ కంప్యూటర్‌కు కనెక్ట్ · Connect to the shop computer</button>
      <button class="act ghost" id="kkX">మూసివేయండి · Close</button>`;
    s.querySelector('#kkSave').onclick=()=>{ cfg.aiKey=s.querySelector('#kkKey').value.trim(); saveCfg(); location.reload(); };
    s.querySelector('#kkPair').onclick=()=>{ cfg.alone=false; saveCfg(); MODE='new'; openLink(); };
    s.querySelector('#kkX').onclick=closeLink; return;
  }
  /* new phone: pair */
  s.innerHTML = `<h2>షాప్ కంప్యూటర్‌తో కలపండి · Connect to the shop computer</h2>
    <p>1. కంప్యూటర్‌లో AgriKountr తెరిచి <b>📱 ఫోన్ కలపండి</b> నొక్కండి.<br>2. ఫోన్ అదే Wi-Fi లో ఉండాలి.<br>3. స్క్రీన్ మీద QR ఫోటో తీయండి.</p>
    <p class="note">Open AgriKountr on the computer, tap “📱 Connect phone”, stay on the same Wi-Fi, then photograph the QR code on the screen.</p>
    <button class="act green" id="kkQR" style="min-height:90px;font-size:22px">📷 QR ఫోటో తీయండి · Photograph the QR</button>
    <details><summary class="note">QR పని చేయకపోతే · Type the address instead</summary>
      <div class="fgrid" style="margin-top:8px"><label class="f w">Computer address<input id="kkAddr" placeholder="192.168.1.20:8765" inputmode="url"></label>
      <label class="f">Code<input id="kkCode" inputmode="numeric" maxlength="6" placeholder="123456"></label>
      <label class="f">ఫోన్ పేరు · Phone name<input id="kkName" value="${esc(cfg.deviceName||'')}" placeholder="Ramu phone"></label></div>
      <button class="act blue" id="kkGo">కలపండి · Connect</button></details>
    <button class="act ghost" id="kkAlone">కంప్యూటర్ లేదు · Use this phone alone</button>
    <div id="kkMsg" class="note"></div>`;
  const msg = t=>{ s.querySelector('#kkMsg').textContent=t; };
  s.querySelector('#kkAlone').onclick=()=>{ cfg.alone=true; saveCfg(); MODE='alone'; location.reload(); };
  s.querySelector('#kkGo').onclick=()=>pairWith(s.querySelector('#kkAddr').value.trim(), s.querySelector('#kkCode').value.trim(), s.querySelector('#kkName').value.trim(), msg);
  s.querySelector('#kkQR').onclick=()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.capture='environment';
    inp.onchange=async()=>{ const f=inp.files&&inp.files[0]; if(!f) return; msg('QR చదువుతోంది… Reading the QR');
      try{ const txt=await readQrFromFile(f); const j=JSON.parse(txt); if(j.kk!==1) throw 0; await pairWith(j.addr, j.code, s.querySelector('#kkName').value.trim(), msg, j.alt); }
      catch(e){ msg('QR దొరకలేదు. దగ్గరగా, నేరుగా ఫోటో తీయండి · No AgriKountr QR found. Hold the phone closer and straight.'); } };
    inp.click(); };
}
async function readQrFromFile(f){
  const bmp = await createImageBitmap(f);
  if('BarcodeDetector' in window){ try{ const r=await new BarcodeDetector({formats:['qr_code']}).detect(bmp); if(r[0]) return r[0].rawValue; }catch(e){} }
  if(!window.jsQR) await new Promise((ok,no)=>{ const sc=document.createElement('script'); sc.src='vendor/jsQR.js'; sc.onload=ok; sc.onerror=no; document.head.appendChild(sc); });
  for(const scale of [1, 0.6, 0.35]){ const c=document.createElement('canvas'); c.width=Math.round(bmp.width*scale); c.height=Math.round(bmp.height*scale); const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(bmp,0,0,c.width,c.height);
    const code=window.jsQR(g.getImageData(0,0,c.width,c.height).data, c.width, c.height, {inversionAttempts:'attemptBoth'}); if(code) return code.data; }
  throw new Error('no qr');
}
async function pairWith(addr, code, name, msg, alts){
  const tryAddrs = [addr, ...(alts||[])].filter(Boolean).map(a=>/^https?:\/\//.test(a)?a:'http://'+a);
  if(!tryAddrs.length || !/^\d{6}$/.test(String(code))){ msg('Address and 6-digit code needed'); return; }
  for(const a of tryAddrs){
    msg('కలుపుతోంది… Connecting to '+a);
    try{
      const r = await fetch(a.replace(/\/$/,'')+'/api/pair', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code:String(code), deviceId:cfg.deviceId, name:name||('Phone '+cfg.deviceId.slice(-4))})});
      const j = await r.json().catch(()=>({}));
      if(!r.ok){ msg(j.error==='bad_code'?'కోడ్ తప్పు లేదా గడువు అయింది · Wrong or expired code. Make a new one on the computer.':'Could not connect: '+(j.error||r.status)); return; }
      cfg.server=a.replace(/\/$/,''); cfg.token=j.token; cfg.devCode=j.code||''; cfg.role=j.role||'staff'; cfg.shopName=j.shopName||''; cfg.deviceName=name||cfg.deviceName||''; cfg.alone=false; saveCfg();
      msg('✅ కలిసింది · Connected. Loading shop data…'); setTimeout(()=>location.reload(), 600); return;
    }catch(e){ /* try next address */ }
  }
  msg('కంప్యూటర్ దొరకలేదు. ఫోన్ అదే Wi-Fi లో ఉందో చూడండి · Computer not found. Check the phone is on the same Wi-Fi as the computer.');
}
async function desktopPanel(s){
  let info={}; try{ info=await api('/api/admin'); }catch(e){}
  s.innerHTML = `<h2>📱 ఫోన్ కలపండి · Connect a phone</h2>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
      <div id="kkQrBox" style="background:#fff;padding:10px;border-radius:12px;min-width:200px;min-height:200px"></div>
      <div><div class="note">కోడ్ · Code</div><div style="font-size:44px;font-weight:800;letter-spacing:.12em" id="kkCodeBig">——————</div>
      <div class="note">Address: <b id="kkAddrs"></b></div><div class="note" id="kkExp"></div>
      <div class="chips" style="margin-top:8px"><button class="chip on" data-role="staff">సిబ్బంది · Staff</button><button class="chip" data-role="owner">యజమాని · Owner</button></div></div>
    </div>
    <p class="note">Phone and computer must be on the same Wi-Fi (or the computer joined to the phone's hotspot). In the phone app, tap “Photograph the QR”.</p>
    <div class="card"><h3>కలిసిన ఫోన్లు · Connected phones</h3><div id="kkDevs"></div></div>
    <div class="card"><h3>AI బిల్లు రీడర్ · AI bill reader</h3>
      <label class="f">AI key (Anthropic)<input id="kkKey" type="password" value="${info.hasKey?'••••••••':''}" placeholder="sk-ant-..."></label>
      <div class="note">${info.hasKey?'✓ Key saved on this computer. Phones use it through this computer; the key never goes to phones.':'Needed for reading bill photos. Get one at console.anthropic.com.'}</div>
      <button class="act blue" id="kkKeySave">సేవ్ · Save key</button></div>
    <div class="card" id="kkCloud"></div>
    <div class="card"><h3>బ్యాకప్ · Backup on this computer</h3><div class="note">Automatic copy every day in: <b>${esc(info.backupDir||'')}</b>${info.lastBackup?' · last: '+esc(info.lastBackup):''}</div>
      <label class="f">Extra backup folder (Google Drive / pen drive)<input id="kkBk" value="${esc(info.extraBackupDir||'')}" placeholder="G:\\My Drive\\AgriKountr"></label>
      <button class="act ghost" id="kkBkSave">సేవ్ · Save folder</button><button class="act ghost" id="kkBkNow">ఇప్పుడే బ్యాకప్ · Back up now</button></div>
    <button class="act ghost" id="kkX">మూసివేయండి · Close</button>`;
  let role='staff';
  s.querySelectorAll('[data-role]').forEach(b=>b.onclick=()=>{ role=b.dataset.role; s.querySelectorAll('[data-role]').forEach(x=>x.classList.toggle('on',x===b)); newCode(); });
  async function newCode(){
    try{ const r=await api('/api/pair-code',{method:'POST', body:JSON.stringify({role})});
      s.querySelector('#kkCodeBig').textContent=r.code; s.querySelector('#kkAddrs').textContent=r.addrs.join('  or  ');
      s.querySelector('#kkExp').textContent='Valid for 10 minutes';
      const box=s.querySelector('#kkQrBox'); box.innerHTML='';
      if(!window.QRCode) await new Promise((ok)=>{ const sc=document.createElement('script'); sc.src='vendor/qrcode.min.js'; sc.onload=ok; sc.onerror=ok; document.head.appendChild(sc); });
      if(window.QRCode) new QRCode(box,{text:JSON.stringify({kk:1, addr:r.addrs[0], alt:r.addrs.slice(1), code:r.code}), width:200, height:200, correctLevel:QRCode.CorrectLevel.M});
    }catch(e){ s.querySelector('#kkExp').textContent='Could not make a code: '+(e.message||e.code||''); }
  }
  async function devs(){ try{ const r=await api('/api/devices'); s.querySelector('#kkDevs').innerHTML=(r.list||[]).filter(d=>d.id!==cfg.deviceId).map(d=>`<div class="line"><div class="grow"><div class="nm">${esc(d.name||d.id)}</div><div class="sub">${d.role} · last seen ${d.lastSeen?new Date(d.lastSeen).toLocaleString('en-IN'):'—'}</div></div><button class="act ghost" style="min-height:40px;font-size:14px;padding:6px 10px;width:auto" data-rm="${esc(d.id)}">తీసేయి · Remove</button></div>`).join('')||'<div class="note">No phones yet</div>';
    s.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async()=>{ await api('/api/devices/remove',{method:'POST', body:JSON.stringify({id:b.dataset.rm})}); devs(); }); }catch(e){} }
  s.querySelector('#kkKeySave').onclick=async()=>{ const k=s.querySelector('#kkKey').value.trim(); if(!k||k.startsWith('•')) return; await api('/api/admin',{method:'POST', body:JSON.stringify({aiKey:k})}); desktopPanel(s); };
  s.querySelector('#kkBkSave').onclick=async()=>{ await api('/api/admin',{method:'POST', body:JSON.stringify({extraBackupDir:s.querySelector('#kkBk').value.trim()})}); desktopPanel(s); };
  s.querySelector('#kkBkNow').onclick=async()=>{ await api('/api/backup-now',{method:'POST', body:'{}'}); desktopPanel(s); };
  s.querySelector('#kkX').onclick=closeLink;
  newCode(); devs(); cloudCard(s.querySelector('#kkCloud'));
}

/* ---------- Google Drive backup card (shop computer only) ---------- */
const when = iso => iso ? new Date(iso).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}) : '';
async function cloudCard(box, view){
  if(!box) return;
  let st={}; try{ st=await api('/api/cloud/status'); }catch(e){ box.innerHTML='<div class="note">Could not read cloud backup status.</div>'; return; }
  const msg=(t,bad)=>{ const m=box.querySelector('#kcMsg'); if(m){ m.textContent=t; m.style.color=bad?'#b3261e':''; } };
  const head=`<h3>☁️ గూగుల్ డ్రైవ్ బ్యాకప్ · Google Drive backup</h3>`;
  if(view==='restore') return restoreView(box, st);
  if(!st.configured){ box.innerHTML=head+`<div class="note">This copy of the app was built without a Google key, so Drive backup is off. Use the extra backup folder below meanwhile.</div>`; return; }
  let html=head;
  if(st.safe) html+=`<div style="background:#e6f4ea;border-radius:10px;padding:10px;font-weight:700;color:#1e6b34">✓ మీ డేటా భద్రం · Your data is safe<br><span style="font-weight:400">Last saved to Google Drive ${esc(when(st.lastOk))}${st.email?' · '+esc(st.email):''}</span></div>`;
  else if(st.connected&&st.hasPin) html+=`<div style="background:#fdecea;border-radius:10px;padding:10px;font-weight:700;color:#b3261e">⚠ Last Drive backup: ${st.lastOk?esc(when(st.lastOk)):'never'}${st.lastError?'<br><span style="font-weight:400">'+esc(st.lastError)+'</span>':''}</div>`;
  if(!st.hasPin){
    html+=`<p class="note"><b>Step 1.</b> Choose a backup PIN, 6 to 12 digits. Write it on paper and keep it with your licences. Without this PIN nobody can open the backup, not even us.</p>
      <div class="fgrid"><label class="f">PIN<input id="kcP1" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password"></label><label class="f">PIN again<input id="kcP2" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password"></label></div>
      <button class="act green" id="kcPin">PIN పెట్టండి · Set PIN</button>`;
  } else if(!st.connected){
    html+=`<p class="note">${st.signInNeeded?'<b style="color:#b3261e">Google sign-in has expired.</b> ':'<b>Step 2.</b> '}Sign in with the shop's Google account (Gmail). The browser opens. Press <b>Allow</b>, then come back here.</p>
      <button class="act blue" id="kcIn">గూగుల్‌తో లాగిన్ · Sign in with Google</button>`;
  } else {
    html+=`<div class="btnrow"><button class="act ghost" id="kcNow">ఇప్పుడే · Back up now</button><button class="act ghost" id="kcRe">తిరిగి తెచ్చు · Restore</button></div>
      <details><summary class="note">More</summary><button class="act ghost" id="kcPinCh">Change PIN</button><button class="act ghost" style="color:#b3261e" id="kcOut">Disconnect Google Drive</button></details>`;
  }
  if(!st.connected) html+=`<button class="act ghost" id="kcRe">కొత్త కంప్యూటర్? పాత డేటా తెచ్చు · New computer? Restore old data</button>`;
  html+=`<div class="note" id="kcMsg"></div>`;
  box.innerHTML=html;
  const on=(id,f)=>{ const b=box.querySelector('#'+id); if(b) b.onclick=f; };
  const call=async(path,b,busyText)=>{ msg(busyText||'…'); try{ const r=await api(path,{method:'POST', body:JSON.stringify(b||{}), timeout:180000}); msg(''); return r; }catch(e){ let m=e&&e.message; try{ m=JSON.parse(m).error||m; }catch(x){} msg(m||'Something went wrong',true); throw e; } };
  on('kcPin', async()=>{ try{ await call('/api/cloud/pin',{pin:box.querySelector('#kcP1').value, pin2:box.querySelector('#kcP2').value},'Saving PIN…'); cloudCard(box); }catch(e){} });
  on('kcPinCh', ()=>{ box.innerHTML=head+`<p class="note">New PIN for future backups. Old backups still open with the old PIN.</p><div class="fgrid"><label class="f">New PIN<input id="kcP1" type="password" inputmode="numeric" maxlength="12"></label><label class="f">Again<input id="kcP2" type="password" inputmode="numeric" maxlength="12"></label></div><button class="act green" id="kcPin">సేవ్ · Save</button><button class="act ghost" id="kcBack">వెనక్కి · Back</button><div class="note" id="kcMsg"></div>`;
    on('kcPin', async()=>{ try{ await call('/api/cloud/pin',{pin:box.querySelector('#kcP1').value, pin2:box.querySelector('#kcP2').value}); await call('/api/cloud/backup',{},'Backing up with the new PIN…'); }catch(e){} cloudCard(box); }); on('kcBack', ()=>cloudCard(box)); });
  on('kcIn', async()=>{ try{ const r=await call('/api/cloud/signin',{},'Opening the browser…'); if(r.url && !r.opened) window.open(r.url,'_blank'); msg('Finish in the browser, then come back.');
    const t0=Date.now(); const poll=setInterval(async()=>{ try{ const s2=await api('/api/cloud/status'); if(s2.connected || Date.now()-t0>10*60e3 || !document.body.contains(box)){ clearInterval(poll); cloudCard(box); } }catch(e){} }, 2500); }catch(e){} });
  on('kcNow', async()=>{ try{ await call('/api/cloud/backup',{},'Saving to Google Drive…'); }catch(e){} cloudCard(box); });
  on('kcOut', async()=>{ if(box.dataset.sure!=='1'){ box.dataset.sure='1'; msg('Tap Disconnect again to stop Drive backups.',true); return; } box.dataset.sure=''; try{ await call('/api/cloud/disconnect'); }catch(e){} cloudCard(box); });
  on('kcRe', ()=>cloudCard(box,'restore'));
}
async function restoreView(box, st){
  const head=`<h3>☁️ పాత డేటా తెచ్చు · Restore from Google Drive</h3>`;
  if(!st.connected){ box.innerHTML=head+`<p class="note">First sign in with the Google account that has the backups.</p><button class="act blue" id="kcIn2">Sign in with Google</button><button class="act ghost" id="kcBack">వెనక్కి · Back</button><div class="note" id="kcMsg"></div>`;
    box.querySelector('#kcBack').onclick=()=>cloudCard(box);
    box.querySelector('#kcIn2').onclick=async()=>{ try{ const r=await api('/api/cloud/signin',{method:'POST',body:'{}'}); if(r.url && !r.opened) window.open(r.url,'_blank'); box.querySelector('#kcMsg').textContent='Finish in the browser, then come back.';
      const poll=setInterval(async()=>{ try{ const s2=await api('/api/cloud/status'); if(s2.connected||!document.body.contains(box)){ clearInterval(poll); restoreView(box, s2); } }catch(e){} }, 2500); }catch(e){ box.querySelector('#kcMsg').textContent='Could not start sign-in'; } };
    return; }
  box.innerHTML=head+`<div class="note">Looking in Google Drive…</div>`;
  let list=[]; try{ list=(await api('/api/cloud/list',{timeout:60000})).list||[]; }catch(e){ box.innerHTML=head+`<div class="note" style="color:#b3261e">Could not read Google Drive. Check the internet.</div><button class="act ghost" id="kcBack">వెనక్కి · Back</button>`; box.querySelector('#kcBack').onclick=()=>cloudCard(box); return; }
  if(!list.length){ box.innerHTML=head+`<div class="note">No AgriKountr backups in this Google account${st.email?' ('+esc(st.email)+')':''}.</div><button class="act ghost" id="kcBack">వెనక్కి · Back</button>`; box.querySelector('#kcBack').onclick=()=>cloudCard(box); return; }
  let pick=list[0].id;
  box.innerHTML=head+`<div class="note">Pick a backup (newest first):</div>
    <div class="chips" style="flex-direction:column;align-items:stretch">${list.slice(0,12).map((x,i)=>`<button class="chip ${i===0?'on':''}" data-id="${esc(x.id)}" style="text-align:left">${esc(when(x.at))}${x.shop?' · '+esc(x.shop):''}${x.docs?' · '+x.docs+' records':''}</button>`).join('')}</div>
    <label class="f">బ్యాకప్ PIN · Backup PIN<input id="kcRP" type="password" inputmode="numeric" maxlength="12"></label>
    <p class="note" style="color:#8a4a00">This replaces everything on this computer with the backup. What is here now is first saved in the backups folder.</p>
    <button class="act yellow" id="kcGo">తిరిగి తెచ్చు · Restore</button><button class="act ghost" id="kcBack">వెనక్కి · Back</button><div class="note" id="kcMsg"></div>`;
  box.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{ pick=b.dataset.id; box.querySelectorAll('[data-id]').forEach(x=>x.classList.toggle('on',x===b)); });
  box.querySelector('#kcBack').onclick=()=>cloudCard(box);
  box.querySelector('#kcGo').onclick=async()=>{
    const m=box.querySelector('#kcMsg'); m.style.color=''; m.textContent='Opening the backup… (this takes a few seconds)';
    try{ const r=await api('/api/cloud/restore',{method:'POST', body:JSON.stringify({id:pick, pin:box.querySelector('#kcRP').value}), timeout:180000});
      m.textContent=`✓ Restored ${r.docs} records from ${when(r.at)}. Reloading…`; await resetLocal(); setTimeout(()=>location.reload(), 1200); }
    catch(e){ let t=e&&e.message; try{ t=JSON.parse(t).error||t; }catch(x){} m.style.color='#b3261e'; m.textContent=t||'Could not restore'; }
  };
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* first run on a phone: show the connect screen */
window.addEventListener('load', async()=>{ await init(); if(MODE==='new') openLink(); });
})();
