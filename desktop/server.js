/* Krishi Khata shop server.
   Runs inside the desktop app on the shop computer (or alone with `node server.js` for testing).
   - keeps the shop's data (the master copy)
   - phones on the same Wi-Fi pair with a 6-digit code and sync changes
   - reads bill photos with the AI service (the key stays on this computer)
   - checks AI readings with an on-device OCR reader
   - backs up every day */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { makeEwb } = require('./ewb');

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const MODELS = {quick:'claude-haiku-5-5', default:'claude-sonnet-5-5', complex:'claude-opus-5-5'};

function start(opts={}){
  const PORT = Number(opts.port || process.env.KK_PORT || 8765);
  const DATA = opts.dataDir || process.env.KK_DATA || path.join(__dirname, 'data');
  const WEB = opts.webDir || process.env.KK_WEB || [path.join(__dirname,'web'), path.join(__dirname,'..','web')].find(p=>fs.existsSync(path.join(p,'index.html')));
  const log = opts.log || ((...a)=>console.log(new Date().toISOString(), ...a));
  fs.mkdirSync(DATA, {recursive:true});
  const DBF = path.join(DATA, 'shop.json'), SETF = path.join(DATA, 'settings.json'), BKD = path.join(DATA, 'backups');
  fs.mkdirSync(BKD, {recursive:true});

  /* ---------- store ---------- */
  let store = {seq:0, docs:{}};
  try{ store = JSON.parse(fs.readFileSync(DBF,'utf8')); }catch(e){ if(fs.existsSync(DBF)) log('could not read store, starting empty', e.message); }
  let settings = {devices:{}, aiKey:'', extraBackupDir:'', shopName:''};
  try{ settings = {...settings, ...JSON.parse(fs.readFileSync(SETF,'utf8'))}; }catch(e){}
  let dirty=false, saveT=null;
  function writeAtomic(file, text){ const tmp=file+'.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  function saveStore(){ dirty=true; if(saveT) return; saveT=setTimeout(()=>{ saveT=null; if(!dirty) return; dirty=false; try{ writeAtomic(DBF, JSON.stringify(store)); }catch(e){ log('save failed', e.message); } }, 400); }
  function saveSettings(){ try{ writeAtomic(SETF, JSON.stringify(settings, null, 1)); }catch(e){ log('settings save failed', e.message); } }
  function shopName(){ const d=store.docs['shops/main']; return (d&&d.data&&d.data.name)||settings.shopName||''; }

  /* ---------- backups ---------- */
  function backupNow(){
    const day = new Date().toISOString().slice(0,10);
    const text = JSON.stringify(store);
    const f = path.join(BKD, `shop-${day}.json`);
    try{ writeAtomic(f, text); }catch(e){ log('backup failed', e.message); }
    if(settings.extraBackupDir){ try{ fs.mkdirSync(settings.extraBackupDir,{recursive:true}); writeAtomic(path.join(settings.extraBackupDir, `krishi-khata-${day}.json`), text); }catch(e){ log('extra backup failed', e.message); } }
    const all = fs.readdirSync(BKD).filter(x=>/^shop-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    while(all.length>30){ try{ fs.unlinkSync(path.join(BKD, all.shift())); }catch(e){ break; } }
    settings.lastBackup = new Date().toISOString(); saveSettings();
  }
  setTimeout(backupNow, 5000); setInterval(backupNow, 6*3600*1000);

  /* ---------- devices & pairing ---------- */
  let pairCode = null; // {code, role, exp}
  const isLocal = req => { const a=(req.socket.remoteAddress||'').replace('::ffff:',''); return a==='127.0.0.1' || a==='::1'; };
  function deviceFor(req, url){
    if(isLocal(req)) return {id:req.headers['x-kk-device']||'desktop', role:'owner', name:'Shop computer', local:true};
    const tok = req.headers['x-kk-token'] || (url && url.searchParams.get('t')) || '';
    if(!tok) return null;
    return Object.values(settings.devices).find(d=>d.token && crypto.timingSafeEqual(Buffer.from(d.token.padEnd(64)), Buffer.from(String(tok).padEnd(64).slice(0,64)))) || null;
  }
  /* each paired phone gets a short letter (B, C, …) used in its own invoice series, so numbers stay within 16 characters */
  function nextDevCode(){ const used=new Set(Object.values(settings.devices).map(d=>d.code)); const A='BCDEFGHJKLMNPQRSTUVWXYZ'; for(const a of A) if(!used.has(a)) return a; for(const a of A) for(const b of A) if(!used.has(a+b)) return a+b; return 'X'; }
  for(const d of Object.values(settings.devices)) if(!d.code){ d.code=nextDevCode(); }
  const ewb = makeEwb({settings, saveSettings, log});
  function lanAddrs(){ const out=[]; for(const list of Object.values(os.networkInterfaces())) for(const n of list||[]) if(n.family==='IPv4' && !n.internal) out.push(`${n.address}:${PORT}`); return out.length?out:[`127.0.0.1:${PORT}`]; }

  /* ---------- live updates (server-sent events) ---------- */
  const clients = new Set(); const presence = new Map();
  function broadcast(event, data){ const msg=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for(const c of clients){ try{ c.res.write(msg); }catch(e){} } }
  function peersList(){ const now=Date.now(); const out=[]; for(const [id,p] of presence){ if(now-p.ts<70000) out.push({device:id, name:p.name, presence:p.presence}); } return out; }
  setInterval(()=>{ for(const c of clients){ try{ c.res.write(': ping\n\n'); }catch(e){} } }, 25000);

  /* ---------- AI relay ---------- */
  async function ai({prompt, images, tier}){
    if(!settings.aiKey) throw Object.assign(new Error('AI key not set'), {status:503});
    const content = [...(images||[]).map(i=>({type:'image', source:{type:'base64', media_type:i.media_type||'image/jpeg', data:i.data}})), {type:'text', text:String(prompt||'')}];
    const model = (settings.models&&settings.models[tier]) || MODELS[tier] || MODELS.default;
    const r = await fetch('https://api.anthropic.com/v1/messages', {method:'POST', headers:{'content-type':'application/json','x-api-key':settings.aiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({model, max_tokens:4096, messages:[{role:'user', content}]})});
    if(r.status===429) throw Object.assign(new Error('rate limited'), {status:429});
    if(!r.ok){ const t=await r.text(); throw Object.assign(new Error('AI error '+r.status+': '+t.slice(0,300)), {status:502}); }
    const j = await r.json(); return (j.content||[]).map(c=>c.text||'').join('');
  }

  /* ---------- on-device OCR checker ---------- */
  let ocrWorker = null, ocrBusy = Promise.resolve();
  async function getOcr(){
    if(ocrWorker) return ocrWorker;
    const T = require('tesseract.js');
    let langPath; try{ langPath = path.dirname(require.resolve('@tesseract.js-data/eng/package.json')); }catch(e){}
    const dataDir = langPath ? path.join(langPath, fs.existsSync(path.join(langPath,'4.0.0_best_int'))?'4.0.0_best_int':'4.0.0') : undefined;
    ocrWorker = await T.createWorker('eng', 1, {langPath:dataDir, cachePath:path.join(DATA,'ocr-cache'), gzip:true, logger:()=>{}});
    return ocrWorker;
  }
  async function ocr(b64){
    const job = ocrBusy.then(async()=>{ const w=await getOcr(); const {data} = await w.recognize(Buffer.from(b64,'base64')); return {text:data.text||'', confidence:data.confidence||0}; });
    ocrBusy = job.catch(()=>{}); return job;
  }

  /* ---------- http ---------- */
  function send(res, code, obj, extra={}){ const b=JSON.stringify(obj); res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*', ...extra}); res.end(b); }
  function body(req, limit=40e6){ return new Promise((ok,no)=>{ let n=0; const parts=[]; req.on('data',c=>{ n+=c.length; if(n>limit){ no(Object.assign(new Error('too large'),{status:413})); req.destroy(); } else parts.push(c); }); req.on('end',()=>{ try{ ok(parts.length?JSON.parse(Buffer.concat(parts).toString('utf8')):{}); }catch(e){ no(Object.assign(e,{status:400})); } }); req.on('error',no); }); }
  const validPath = p => typeof p==='string' && p.length<1000 && /^[A-Za-z0-9_\-.~:@+]+(\/[A-Za-z0-9_\-.~:@+]+)+$/.test(p) && p.split('/').length%2===0;

  const server = http.createServer(async (req, res)=>{
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if(req.method==='OPTIONS'){ res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, X-KK-Token, X-KK-Device','Access-Control-Allow-Methods':'GET, POST, OPTIONS'}); return res.end(); }
    try{
      if(p.startsWith('/api/')){
        if(p==='/api/info') return send(res, 200, {app:'krishi-khata', version:1, local:isLocal(req), shopName:shopName()});
        if(p==='/api/pair' && req.method==='POST'){
          const b=await body(req, 1e5);
          if(!pairCode || Date.now()>pairCode.exp || String(b.code)!==pairCode.code) return send(res, 403, {error:'bad_code'});
          const id=String(b.deviceId||'').slice(0,40)||('d_'+crypto.randomBytes(4).toString('hex'));
          const token=crypto.randomBytes(24).toString('hex');
          const code=(settings.devices[id]&&settings.devices[id].code)||nextDevCode();
          settings.devices[id]={id, name:String(b.name||'Phone').slice(0,40), role:pairCode.role, token, code, pairedAt:new Date().toISOString(), lastSeen:new Date().toISOString()};
          saveSettings(); log('paired', id, settings.devices[id].name, code);
          return send(res, 200, {token, role:pairCode.role, shopName:shopName(), code});
        }
        const dev = deviceFor(req, url);
        if(!dev) return send(res, 401, {error:'not_paired'});
        if(!dev.local && settings.devices[dev.id]){ settings.devices[dev.id].lastSeen=new Date().toISOString(); }

        if(p==='/api/sync' && req.method==='GET'){
          const since=Number(url.searchParams.get('since')||0), limit=Math.min(2000, Number(url.searchParams.get('limit')||500));
          const list=[]; for(const [k,v] of Object.entries(store.docs)) if(v.seq>since) list.push({path:k, data:v.data, seq:v.seq});
          list.sort((a,b)=>a.seq-b.seq); const out=list.slice(0,limit);
          return send(res, 200, {changes:out, seq: out.length?out[out.length-1].seq:store.seq, more:list.length>limit});
        }
        if(p==='/api/sync' && req.method==='POST'){
          const b=await body(req); const rejected=[]; let n=0;
          for(const c of (b.changes||[])){
            if(!validPath(c.path)){ rejected.push(c.path); continue; }
            if(dev.role==='staff' && /^shops\/main\/(licences|vouchers)\//.test(c.path) && c.data===null){ rejected.push(c.path); continue; }
            let data = c.data===undefined?null:c.data;
            const cur = store.docs[c.path] && store.docs[c.path].data;
            if(data && cur && c.inc){            /* merge stock and dues changes from devices that were offline */
              data = JSON.parse(JSON.stringify(data));
              if(c.inc.loc){ const loc={...(cur.loc||{})}; for(const [k,d] of Object.entries(c.inc.loc)) loc[k]=Math.max(0, Math.round(((Number(loc[k])||0)+Number(d))*1000)/1000); data.loc=loc; data.qty=Object.values(loc).reduce((a,b)=>a+(Number(b)||0),0); }
              if(typeof c.inc.due==='number'){ data.due=Math.round(((Number(cur.due)||0)+c.inc.due)*100)/100; }
              if(Array.isArray(c.histAdd)){ const key=h=>[h.t,h.type,h.amt].join('|'); const seen=new Set(); const all=[...(cur.hist||[]), ...c.histAdd].filter(h=>{ const k=key(h); if(seen.has(k)) return false; seen.add(k); return true; }); all.sort((x,y)=>String(x.t).localeCompare(String(y.t))); data.hist=all.slice(-400); }
            }
            store.seq++; store.docs[c.path]={data, seq:store.seq, ts:Date.now(), dev:dev.id, cts:c.ts||0}; n++;
          }
          if(n){ saveStore(); broadcast('change', {seq:store.seq}); }
          return send(res, 200, {ok:true, seq:store.seq, rejected});
        }
        if(p==='/api/events'){
          res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
          res.write(`event: change\ndata: {"seq":${store.seq}}\n\n`); res.write(`event: peers\ndata: ${JSON.stringify(peersList())}\n\n`);
          const c={res, dev:dev.id}; clients.add(c); req.on('close',()=>clients.delete(c)); return;
        }
        if(p==='/api/presence' && req.method==='POST'){
          const b=await body(req, 1e5); presence.set(dev.id, {ts:Date.now(), name:dev.local?'Shop computer':(dev.name||''), presence:b.presence||{}});
          broadcast('peers', peersList()); return send(res, 200, {peers:peersList()});
        }
        if(p==='/api/me') return send(res, 200, {id:dev.id, role:dev.role, name:dev.name, code:dev.local?'':(dev.code||''), local:!!dev.local});
        /* e-way bills: any paired device may make one; cancelling is for the owner */
        if(p==='/api/ewb/status') return send(res, 200, dev.local?ewb.details():ewb.status());
        if(p==='/api/ewb/generate' && req.method==='POST'){ const b=await body(req,1e6); return send(res, 200, await ewb.generate(b.payload)); }
        if(p==='/api/ewb/vehicle' && req.method==='POST'){ const b=await body(req,1e5); return send(res, 200, await ewb.vehicle(b)); }
        if(p==='/api/ewb/cancel' && req.method==='POST'){ if(dev.role!=='owner') return send(res, 403, {error:'Only the owner can cancel an e-way bill'}); const b=await body(req,1e5); return send(res, 200, await ewb.cancel(b)); }
        if(p==='/api/devices'){ const list=Object.values(settings.devices).map(({token,...d})=>d); const names={}; list.forEach(d=>names[d.id]=d.name); names[dev.id]=names[dev.id]||dev.name; return send(res, 200, {list, names}); }
        if(p==='/api/ai' && req.method==='POST'){ const b=await body(req); const text=await ai(b); return send(res, 200, {text}); }
        if(p==='/api/ocr' && req.method==='POST'){ const b=await body(req); try{ return send(res, 200, await ocr(b.image)); }catch(e){ return send(res, 501, {error:'ocr_unavailable', message:e.message}); } }

        /* owner-only, from the shop computer itself */
        if(!dev.local) return send(res, 403, {error:'computer_only'});
        if(p==='/api/pair-code' && req.method==='POST'){ const b=await body(req,1e4); pairCode={code:String(crypto.randomInt(0,1e6)).padStart(6,'0'), role:b.role==='owner'?'owner':'staff', exp:Date.now()+10*60*1000}; return send(res, 200, {code:pairCode.code, role:pairCode.role, addrs:lanAddrs(), expires:pairCode.exp}); }
        if(p==='/api/devices/remove' && req.method==='POST'){ const b=await body(req,1e4); delete settings.devices[b.id]; saveSettings(); return send(res, 200, {ok:true}); }
        if(p==='/api/admin' && req.method==='GET') return send(res, 200, {hasKey:!!settings.aiKey, backupDir:BKD, extraBackupDir:settings.extraBackupDir||'', lastBackup:settings.lastBackup||'', addrs:lanAddrs(), dataDir:DATA});
        if(p==='/api/admin' && req.method==='POST'){ const b=await body(req,1e5); if(typeof b.aiKey==='string') settings.aiKey=b.aiKey.trim(); if(typeof b.extraBackupDir==='string') settings.extraBackupDir=b.extraBackupDir; if(b.models) settings.models=b.models; saveSettings(); return send(res, 200, {ok:true}); }
        if(p==='/api/ewb/setup' && req.method==='POST'){ const b=await body(req,1e5); return send(res, 200, ewb.setup(b)); }
        if(p==='/api/ewb/test' && req.method==='POST'){ return send(res, 200, await ewb.test()); }
        if(p==='/api/backup-now' && req.method==='POST'){ backupNow(); return send(res, 200, {ok:true, at:settings.lastBackup}); }
        if(p==='/api/export'){ return send(res, 200, store, {'Content-Disposition':'attachment; filename="krishi-khata-export.json"'}); }
        return send(res, 404, {error:'not_found'});
      }
      /* static app files (the same screens phones use) */
      if(!WEB) return send(res, 500, {error:'web files missing'});
      let fp = path.normalize(path.join(WEB, decodeURIComponent(p==='/'?'/index.html':p)));
      if(!fp.startsWith(WEB)) return send(res, 403, {error:'forbidden'});
      if(!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(WEB, 'index.html');
      res.writeHead(200, {'Content-Type':MIME[path.extname(fp)]||'application/octet-stream', 'Cache-Control':'no-cache'});
      fs.createReadStream(fp).pipe(res);
    }catch(e){
      log('error', p, e.message); send(res, e.status||500, {error:e.message||'error'});
    }
  });
  server.listen(PORT, '0.0.0.0', ()=>log(`Krishi Khata shop server on port ${PORT}; phones connect to ${lanAddrs().join(', ')}; data in ${DATA}`));
  const stop = ()=>{ try{ if(dirty) writeAtomic(DBF, JSON.stringify(store)); }catch(e){} server.close(); };
  return {server, port:PORT, stop, lanAddrs, dataDir:DATA, backupNow};
}

module.exports = { start };
if(require.main === module){ const s=start(); process.on('SIGINT', ()=>{ s.stop(); process.exit(0); }); }
