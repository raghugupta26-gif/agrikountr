/* E-way bill link for the shop computer.
   Phones and the desktop screen send a ready request (NIC e-way bill API v1.03 field names);
   this module sends it to the government system and returns the e-way bill number.
   Login details (API username/password, partner keys) stay in settings.json on this computer only.

   providers:
   - practice: makes pretend numbers so the shop can learn the steps (marked practice everywhere)
   - gsp:      a GST Suvidha Provider (GSP) that passes requests to the NIC e-way bill system.
               The dealer creates the API user once on ewaybillgst.gov.in (Registration → For GSP).
               Endpoint paths and header names differ a little between partners, so they are settings. */
'use strict';
const crypto = require('crypto');

const DEFAULT_GSP = {
  authPath: '/ewaybillapi/v1.03/auth',
  genPath: '/ewaybillapi/v1.03/ewayapi/genewaybill',
  cancelPath: '/ewaybillapi/v1.03/ewayapi/canewb',
  vehiclePath: '/ewaybillapi/v1.03/ewayapi/vehewb',
  headers: {clientId:'client_id', clientSecret:'client_secret', gstin:'gstin', username:'username', password:'password', token:'authtoken'}
};

function validity(genDate, km){ const days=Math.max(1, Math.ceil((Number(km)||1)/200)); const d=new Date(genDate); d.setDate(d.getDate()+days); d.setHours(23,59,0,0); return d.toISOString(); }
/* NIC dates look like "19/11/2026 12:30:00 PM" */
function nicDate(x){
  if(!x) return '';
  const m=String(x).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if(!m) { const d=new Date(x); return isNaN(d)?'':d.toISOString(); }
  let h=Number(m[4]||0); if(m[7]){ const pm=m[7].toUpperCase()==='PM'; if(pm&&h<12) h+=12; if(!pm&&h===12) h=0; }
  return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]), h, Number(m[5]||0), Number(m[6]||0)).toISOString();
}
const err = (msg, status=400) => Object.assign(new Error(msg), {status});

/* basic checks so a bad request never reaches the government system */
function check(p){
  const out=[];
  if(!p || typeof p!=='object') return ['empty request'];
  if(!/^[0-9]{2}[A-Z0-9]{13}$/.test(p.fromGstin||'')) out.push('shop GSTIN');
  if(!(p.toGstin==='URP' || /^[0-9]{2}[A-Z0-9]{13}$/.test(p.toGstin||''))) out.push('buyer GSTIN');
  if(!/^[1-9][0-9]{5}$/.test(String(p.fromPincode||''))) out.push('shop PIN');
  if(!/^[1-9][0-9]{5}$/.test(String(p.toPincode||''))) out.push('buyer PIN');
  if(!p.docNo || String(p.docNo).length>16) out.push('invoice number');
  if(!/^\d{2}\/\d{2}\/\d{4}$/.test(p.docDate||'')) out.push('invoice date');
  if(!Array.isArray(p.itemList) || !p.itemList.length) out.push('items');
  else if(p.itemList.some(i=>String(i.hsnCode||'').length<4)) out.push('HSN code');
  if(Number(p.transDistance)>4000) out.push('distance');
  return out;
}

function makeEwb({settings, saveSettings, log}){
  const cfg = () => settings.ewb || {};
  let token = null, tokenExp = 0;
  const practiceMade = new Map();   // docNo -> result (the real system also refuses the same invoice twice)

  function status(){
    const c=cfg();
    const ready = c.provider==='practice' || (c.provider==='gsp' && !!(c.username && c.password && c.baseUrl));
    return {ready, provider:c.provider||'', practice:c.provider==='practice', user:c.username?c.username.replace(/(.{3}).*(.{3})$/,'$1…$2'):'', partner:c.partner||''};
  }
  /* full details for the settings screen on the shop computer (never the secrets) */
  function details(){ const c=cfg(); return {...status(), username:c.username||'', hasPassword:!!c.password, baseUrl:c.baseUrl||'', clientId:c.clientId||'', hasSecret:!!c.clientSecret}; }
  function setup(b){
    const c={...cfg()};
    if(b.provider==='practice' || b.provider==='gsp') c.provider=b.provider;
    for(const k of ['gstin','username','partner','baseUrl','clientId']) if(typeof b[k]==='string') c[k]=b[k].trim();
    for(const k of ['password','clientSecret']) if(typeof b[k]==='string' && b[k]) c[k]=b[k];
    if(c.baseUrl && !/^https:\/\//.test(c.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(c.baseUrl)) throw err('Partner address must start with https://');
    if(b.paths && typeof b.paths==='object') c.paths={...(c.paths||{}), ...b.paths};
    if(b.headerNames && typeof b.headerNames==='object') c.headerNames={...(c.headerNames||{}), ...b.headerNames};
    settings.ewb=c; token=null; saveSettings(); return details();
  }

  /* ---------- practice ---------- */
  function practiceGenerate(p){
    if(practiceMade.has(p.docNo)) throw err(`An e-way bill already exists for invoice ${p.docNo} (practice)`, 409);
    const now=new Date(); const km=Number(p.transDistance)||(p.fromPincode===p.toPincode?5:Math.min(4000, Math.abs(Number(p.fromPincode)-Number(p.toPincode))%380+20));
    const r={ewbNo:'9'+String(crypto.randomInt(0,1e11)).padStart(11,'0'), ewbDate:now.toISOString(), validUpto:p.vehicleNo?validity(now, km):'', distance:km, practice:true,
      alert: p.vehicleNo?'':'Part-B (vehicle) not given. Add the vehicle before the goods move.'};
    practiceMade.set(p.docNo, r); return r;
  }

  /* ---------- GSP partner ---------- */
  async function gspFetch(path, body, withToken){
    const c=cfg(); const H={...DEFAULT_GSP.headers, ...(c.headerNames||{})};
    const headers={'Content-Type':'application/json', 'Accept':'application/json'};
    if(c.clientId) headers[H.clientId]=c.clientId; if(c.clientSecret) headers[H.clientSecret]=c.clientSecret;
    headers[H.gstin]=c.gstin||''; headers[H.username]=c.username||'';
    if(withToken) headers[H.token]=token; else headers[H.password]=c.password||'';
    const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(), 45000);
    let r; try{ r=await fetch(c.baseUrl.replace(/\/$/,'')+path, {method:'POST', headers, body:JSON.stringify(body||{}), signal:ctl.signal}); }
    catch(e){ throw err('Could not reach the e-way bill system. Check the internet on the shop computer.', 502); }
    finally{ clearTimeout(t); }
    let j=null; const text=await r.text(); try{ j=JSON.parse(text); }catch(e){ j={raw:text.slice(0,300)}; }
    return {http:r.status, j};
  }
  /* partners wrap NIC answers differently; find the parts we need */
  function pick(j, ...keys){ for(const o of [j, j&&j.data, j&&j.result, j&&j.response, j&&j.Data]) if(o && typeof o==='object') for(const k of keys) if(o[k]!==undefined && o[k]!==null && o[k]!=='') return o[k]; return undefined; }
  function failText(j, http){
    const e = pick(j,'error','errors','error_message','errorMessage','message','ErrorMessage','errorList');
    let s = typeof e==='string' ? e : Array.isArray(e) ? e.map(x=>x.message||x.ErrorMessage||x.errorMessage||JSON.stringify(x)).join('; ') : e&&typeof e==='object' ? (e.message||e.errorMessage||JSON.stringify(e)) : '';
    if(!s) s = http>=500 ? 'The e-way bill system is not answering right now. Try again in a few minutes.' : 'The e-way bill system did not accept the request.';
    return s.slice(0,300);
  }
  const okResp = (j, http) => http<300 && j && (String(j.status)==='1' || String(j.status_cd)==='1' || j.success===true || String(j.status).toLowerCase()==='success' || pick(j,'ewayBillNo','ewbNo','EwbNo')!==undefined);
  async function auth(force){
    if(!force && token && Date.now()<tokenExp) return token;
    const c=cfg(); const P={...DEFAULT_GSP, ...(c.paths||{})};
    const {http, j}=await gspFetch(P.authPath, {action:'ACCESSTOKEN', username:c.username, password:c.password}, false);
    const t=pick(j,'authtoken','authToken','AuthToken','token','access_token');
    if(!okResp(j,http) && !t) throw err('Login to the e-way bill system failed: '+failText(j,http), 401);
    if(!t) throw err('The partner answered without a login token.', 502);
    token=String(t); tokenExp=Date.now()+5.5*3600e3; return token;   /* NIC tokens last 6 hours */
  }
  async function gspCall(pathKey, body){
    const c=cfg(); const P={...DEFAULT_GSP, ...(c.paths||{})};
    await auth(false);
    let {http, j}=await gspFetch(P[pathKey], body, true);
    if(http===401 || (/token|auth/i.test(String(pick(j,'error','message')||'')) && !okResp(j,http))){ await auth(true); ({http, j}=await gspFetch(P[pathKey], body, true)); }
    if(!okResp(j,http)) throw err(failText(j,http), http>=500?502:422);
    return j;
  }

  /* ---------- actions ---------- */
  async function generate(p){
    const bad=check(p); if(bad.length) throw err('Please fix: '+bad.join(', '));
    const c=cfg();
    if(c.provider==='practice') return practiceGenerate(p);
    if(!status().ready) throw err('E-way bill link is not set up on the shop computer.', 503);
    const j=await gspCall('genPath', {...p, userGstin:c.gstin||p.fromGstin});
    const no=pick(j,'ewayBillNo','ewbNo','EwbNo');
    if(!no) throw err('The system answered but gave no e-way bill number. Check on the portal before trying again.', 502);
    log('e-way bill', no, 'for', p.docNo);
    return {ewbNo:String(no), ewbDate:nicDate(pick(j,'ewayBillDate','ewbDate','EwbDt'))||new Date().toISOString(), validUpto:nicDate(pick(j,'validUpto','ewbValidTill','EwbValidTill')), distance:Number(pick(j,'distance'))||Number(p.transDistance)||0, alert:pick(j,'alert')||''};
  }
  async function cancel(b){
    const c=cfg(); if(!b || !/^\d{12}$/.test(String(b.ewbNo))) throw err('E-way bill number needed');
    if(c.provider==='practice') return {ewbNo:String(b.ewbNo), cancelDate:new Date().toISOString(), practice:true};
    const j=await gspCall('cancelPath', {ewbNo:Number(b.ewbNo), cancelRsnCode:Number(b.cancelRsnCode)||2, cancelRmrk:String(b.cancelRmrk||'Cancelled').slice(0,50)});
    return {ewbNo:String(b.ewbNo), cancelDate:nicDate(pick(j,'cancelDate'))||new Date().toISOString()};
  }
  async function vehicle(b){
    const c=cfg(); if(!b || !/^\d{12}$/.test(String(b.ewbNo))) throw err('E-way bill number needed');
    if(!/^[A-Z0-9]{6,15}$/.test(String(b.vehicleNo||''))) throw err('Vehicle number looks wrong');
    if(c.provider==='practice') return {vehUpdDate:new Date().toISOString(), validUpto:validity(new Date(), 200), practice:true};
    const j=await gspCall('vehiclePath', {ewbNo:Number(b.ewbNo), vehicleNo:b.vehicleNo, fromPlace:String(b.fromPlace||'').slice(0,50), fromState:Number(b.fromState), reasonCode:String(b.reasonCode||'4'), reasonRem:String(b.reasonRem||'').slice(0,50), transDocNo:b.transDocNo||'', transDocDate:b.transDocDate||'', transMode:String(b.transMode||'1'), vehicleType:b.vehicleType||'R'});
    return {vehUpdDate:nicDate(pick(j,'vehUpdDate'))||new Date().toISOString(), validUpto:nicDate(pick(j,'validUpto'))};
  }
  async function test(){
    const c=cfg();
    if(c.provider==='practice') return {ok:true, practice:true};
    if(!status().ready) throw err('Fill the API username, password and partner address first.');
    await auth(true); return {ok:true};
  }
  return {status, details, setup, generate, cancel, vehicle, test, _check:check, _nicDate:nicDate};
}
module.exports = { makeEwb, validity, nicDate };
