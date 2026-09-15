/* ==================================================================
   parts.js — distributor part search (DigiKey + Mouser).

   Ported from the block architecture editor so a symbol on the sheet
   can be turned into a PHYSICAL part — package, price, stock,
   datasheet — from the Properties panel. Keys live in localStorage
   (or credential/*.json, one click away); they never ride the
   session or any export. Both houses are searched at once and pour
   into one stock-sorted list, each row tagged with its house.
   ================================================================== */
'use strict';

/* ---------- DigiKey: client-credentials OAuth, Product Search v4 ---------- */
const DK_BASE = 'https://api.digikey.com';
function dkConfig(){
  try {
    return { id: localStorage.getItem('dk_client_id') || '',
             secret: localStorage.getItem('dk_client_secret') || '',
             proxy: localStorage.getItem('dk_proxy') || '' };
  } catch(e){ return { id:'', secret:'', proxy:'' }; }
}
function dkSaveConfig(id, secret, proxy){
  try {
    localStorage.setItem('dk_client_id', id);
    localStorage.setItem('dk_client_secret', secret);
    localStorage.setItem('dk_proxy', proxy);
  } catch(e){}
  _dkToken = null;
}
async function dkLoadCredentialFile(){
  const res = await fetch('credential/digikey_credentials.json', { cache:'no-store' });
  if (!res.ok) throw new Error('credential/digikey_credentials.json not found (HTTP ' + res.status + ')');
  const j = await res.json();
  if (!j.client_id || !j.client_secret) throw new Error('digikey_credentials.json is missing client_id / client_secret');
  return { id:String(j.client_id), secret:String(j.client_secret), proxy:String(j.cors_proxy || '') };
}
function dkUrl(path){
  const { proxy } = dkConfig();
  return proxy ? proxy + encodeURIComponent(DK_BASE + path) : DK_BASE + path;
}
/* The body of a failed response names the real reason (bad client, quota,
   maintenance) — a bare HTTP status is undiagnosable from a search box. */
async function httpErrorDetail(res){
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const m = j.error_description || j.ErrorMessage || j.detail || j.message || j.error
        || (j.Errors && j.Errors[0] && (j.Errors[0].Message || j.Errors[0].Code));
      if (m) return ' — ' + String(m).slice(0, 180);
    } catch(_){}
    const t = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? ' — ' + t.slice(0, 180) : '';
  } catch(_){ return ''; }
}
let _dkToken = null;
async function dkToken(){
  const { id, secret } = dkConfig();
  if (!id || !secret) throw new Error('No DigiKey credentials — open "Part search settings"');
  if (_dkToken && Date.now() < _dkToken.exp - 60000) return _dkToken.token;
  const res = await fetch(dkUrl('/v1/oauth2/token'), { method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body:`client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials` });
  if (!res.ok) throw new Error('DigiKey auth failed (HTTP ' + res.status + ')' + await httpErrorDetail(res));
  const j = await res.json();
  _dkToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 600) * 1000 };
  return _dkToken.token;
}
/* Pure: v4 response → picker rows, HIGHEST STOCK FIRST. Liberal about the
   field shapes — DigiKey has shipped several near-identical ones. */
function dkNormalizeProducts(json){
  return ((json && json.Products) || []).map(p => {
    const pn = p.ManufacturerProductNumber || p.ManufacturerPartNumber || '';
    const man = (p.Manufacturer && (p.Manufacturer.Name || p.Manufacturer.Value)) || '';
    const desc = (p.Description && (p.Description.ProductDescription || p.Description.Value)) || p.ProductDescription || '';
    const stock = +(p.QuantityAvailable ?? 0);
    let price = p.UnitPrice;
    if (price == null){
      const breaks = (p.ProductVariations || []).flatMap(v => v.StandardPricing || []);
      if (breaks.length) price = breaks.slice().sort((a, b) => a.BreakQuantity - b.BreakQuantity)[0].UnitPrice;
    }
    return { pn, man, desc, stock, price: price != null ? +price : null, datasheet: p.DatasheetUrl || '' };
  }).filter(x => x.pn).sort((a, b) => b.stock - a.stock || a.pn.localeCompare(b.pn));
}
async function dkSearch(keyword){
  const token = await dkToken();
  const res = await fetch(dkUrl('/products/v4/search/keyword'), { method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token,
      'X-DIGIKEY-Client-Id': dkConfig().id,
      'X-DIGIKEY-Locale-Site':'US', 'X-DIGIKEY-Locale-Currency':searchOptions().currency },
    body: JSON.stringify({ Keywords: keyword, Limit: 25, Offset: 0 }) });
  if (!res.ok) throw new Error('DigiKey search failed (HTTP ' + res.status + ')' + await httpErrorDetail(res));
  return dkNormalizeProducts(await res.json());
}
const dkFmtStock = s => (+s || 0).toLocaleString('en-US');
const CUR_SYMBOL = { USD:'$', EUR:'€' };
/* Two decimals, except under a cent where that would print 0.00: a sub-cent
   amount shows its first significant decimal instead. */
const dkFmtPrice = (p, cur) => {
  if (p == null) return '—';
  const v = +p, sym = CUR_SYMBOL[cur] || '$';
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0 || a >= 0.01) return sym + v.toFixed(2);
  const d = Math.min(20, -Math.floor(Math.log10(a)));
  const s = v.toFixed(d);
  return sym + (Math.abs(+s) >= 0.01 ? v.toFixed(2) : s);
};

/* ---------- Mouser: one Search API key PER CURRENCY (the key's account
   fixes the currency it answers in) ---------- */
const MS_BASE = 'https://api.mouser.com';
const MS_DEFAULT_KEY_USD = '47fe710d-eff2-40d8-8ff7-8edeba348677';
const MS_DEFAULT_KEY_EUR = '7b7a3d60-7a68-4328-9f8c-9a16b02e7f3c';
function msConfig(){
  try {
    const usd = localStorage.getItem('mouser_api_key_usd');
    const eur = localStorage.getItem('mouser_api_key_eur');
    return { usd: usd == null ? MS_DEFAULT_KEY_USD : usd,     // null = never set · '' = cleared on purpose
             eur: eur == null ? MS_DEFAULT_KEY_EUR : eur };
  } catch(e){ return { usd: MS_DEFAULT_KEY_USD, eur: MS_DEFAULT_KEY_EUR }; }
}
function msSaveConfig(usdKey, eurKey){
  try { localStorage.setItem('mouser_api_key_usd', usdKey); localStorage.setItem('mouser_api_key_eur', eurKey); } catch(e){}
}
async function msLoadCredentialFile(){
  const res = await fetch('credential/mouser_credentials.json', { cache:'no-store' });
  if (!res.ok) throw new Error('credential/mouser_credentials.json not found (HTTP ' + res.status + ')');
  const j = await res.json();
  const usd = String(j.api_key_usd || ''), eur = String(j.api_key_eur || j.api_key || '');
  if (!usd && !eur) throw new Error('mouser_credentials.json carries no api_key_usd / api_key_eur');
  return { usd, eur };
}
function msUrl(path){
  const { proxy } = dkConfig();
  return proxy ? proxy + encodeURIComponent(MS_BASE + path) : MS_BASE + path;
}
function searchOptions(){
  try {
    return { digikey: localStorage.getItem('pn_use_digikey') !== '0',
             mouser:  localStorage.getItem('pn_use_mouser') !== '0',
             currency: localStorage.getItem('pn_currency') === 'EUR' ? 'EUR' : 'USD' };
  } catch(e){ return { digikey:true, mouser:true, currency:'USD' }; }
}
function saveSearchOptions(o){
  try {
    localStorage.setItem('pn_use_digikey', o.digikey ? '1' : '0');
    localStorage.setItem('pn_use_mouser',  o.mouser ? '1' : '0');
    localStorage.setItem('pn_currency',    o.currency === 'EUR' ? 'EUR' : 'USD');
  } catch(e){}
}
/* "$0.62", "0,62 €", "1.234,56 €" — the LAST separator is the decimal mark
   when both appear; a lone comma is decimal unless it fronts exactly three
   digits. */
function msParsePrice(raw){
  const s = String(raw ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const dot = s.lastIndexOf('.'), com = s.lastIndexOf(',');
  let dec;
  if (dot >= 0 && com >= 0) dec = Math.max(dot, com);
  else if (dot >= 0) dec = dot;
  else if (com >= 0) dec = (com > 0 && s.length - com - 1 === 3) ? -1 : com;
  else dec = -1;
  const intPart = (dec < 0 ? s : s.slice(0, dec)).replace(/[.,]/g, '');
  const frac = dec < 0 ? '' : s.slice(dec + 1).replace(/[.,]/g, '');
  const v = parseFloat(intPart + (frac ? '.' + frac : ''));
  return Number.isNaN(v) ? null : v;
}
function msNormalizeParts(json, cur){
  const errs = (json && json.Errors) || [];
  if (errs.length) throw new Error('Mouser: ' + (errs[0].Message || errs[0].Code || 'search error'));
  return (((json && json.SearchResults) || {}).Parts || []).map(p => {
    const pn = p.ManufacturerPartNumber || '';
    const stock = parseInt(String(p.AvailabilityInStock ?? p.Availability ?? '0').replace(/[^\d]/g, ''), 10) || 0;
    let price = null, currency = cur || 'USD';
    const breaks = (p.PriceBreaks || []).slice().sort((a, b) => a.Quantity - b.Quantity);
    if (breaks.length){ price = msParsePrice(breaks[0].Price); if (breaks[0].Currency) currency = breaks[0].Currency; }
    return { pn, man: p.Manufacturer || '', desc: p.Description || '', stock, price, currency, datasheet: p.DataSheetUrl || '' };
  }).filter(x => x.pn).sort((a, b) => b.stock - a.stock || a.pn.localeCompare(b.pn));
}
async function msSearchWith(key, keyword, cur){
  const res = await fetch(msUrl('/api/v1/search/partnumber?apiKey=' + encodeURIComponent(key)), { method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: keyword, partSearchOptions: '' } }) });
  if (!res.ok) throw new Error('Mouser search failed (HTTP ' + res.status + ')' + await httpErrorDetail(res));
  return msNormalizeParts(await res.json(), cur);
}
const MS_KEY_REJECTED = /invalid\s*unique\s*identifier|invalid\s*api\s*key/i;
async function msSearch(keyword){
  const cur = searchOptions().currency;
  const k = msConfig();
  const key = cur === 'USD' ? k.usd : k.eur;
  if (!key) throw new Error('No Mouser ' + cur + ' API key — open "Part search settings"');
  try { return await msSearchWith(key, keyword, cur); }
  catch(e){
    if (MS_KEY_REJECTED.test(String((e && e.message) || e)))
      throw new Error(String((e && e.message) || e) + ' — Mouser rejected the ' + cur + ' key; check it is a SEARCH API key (not an Order API one)');
    throw e;
  }
}
function msCurrencyNote(rows, cur){
  const got = [...new Set((rows || []).map(r => r.currency).filter(Boolean))];
  if (!got.length || (got.length === 1 && got[0] === cur)) return '';
  const site = cur === 'USD' ? 'www.mouser.com' : 'eu.mouser.com';
  return 'Mouser answered in ' + got.join('/') + ' — add a ' + cur + ' key (from ' + site + ') to search Mouser in ' + (CUR_SYMBOL[cur] || cur);
}
/* Both houses into ONE list, highest stock first, part number as tie-break. */
function mergePartResults(dkList, msList, cur){
  return [
    ...(dkList || []).map(r => ({ ...r, src:'DigiKey' })),
    ...(msList || []).map(r => ({ ...r, src:'Mouser' })),
  ].map(r => ({ ...r, currency: r.currency || cur || 'USD' }))
   .sort((a, b) => b.stock - a.stock || a.pn.localeCompare(b.pn));
}
/* Mouser rows carry no datasheet link; borrow DigiKey's for that part number. */
async function resolveDatasheetFor(r, search){
  if (r.datasheet) return r.datasheet;
  try {
    const hits = await (search || dkSearch)(r.pn);
    const hit = hits.find(x => x.pn === r.pn) || hits.find(x => x.pn.startsWith(r.pn)) || hits[0];
    return (hit && hit.datasheet) || '';
  } catch(e){ return ''; }
}
/* Every ENABLED house at once; one failing still shows the other's rows,
   with the failure noted next to the count. */
async function partSearch(q){
  const so = searchOptions();
  if (!so.digikey && !so.mouser) throw new Error('Both distributors are turned off — enable one in "Part search settings"');
  const names = [so.digikey ? 'DigiKey' : null, so.mouser ? 'Mouser' : null].filter(Boolean);
  const [dk, ms] = await Promise.allSettled([
    so.digikey ? dkSearch(q) : Promise.resolve(null),
    so.mouser  ? msSearch(q) : Promise.resolve(null) ]);
  const errs = [];
  if (dk.status === 'rejected') errs.push(String((dk.reason && dk.reason.message) || dk.reason));
  if (ms.status === 'rejected') errs.push(String((ms.reason && ms.reason.message) || ms.reason));
  if (errs.length === names.length) throw new Error(errs.join(' · '));
  const msRows = ms.status === 'fulfilled' ? ms.value : null;
  const rows = mergePartResults(dk.status === 'fulfilled' ? dk.value : null, msRows, so.currency);
  const notes = [msCurrencyNote(msRows, so.currency), ...errs].filter(Boolean);
  return { rows, notes, currency: so.currency };
}
/* The suggested query for a symbol: a real part number wins; a generic part
   goes by its value and what it is ("10 kΩ resistor"). */
function partQueryFor(part){
  const def = SYMBOLS[part.kind] || {};
  const pn = String(part.partNumber || '').trim();
  if (pn && pn.toLowerCase() !== pn) return pn;                // "BQ24075-Q1", not "capacitor"
  const val = String(part.value || '').trim();
  return [val, (def.label || '').replace(/\s*\(.*\)/, '').toLowerCase()].filter(Boolean).join(' ');
}

if (typeof module !== 'undefined') module.exports = {
  dkNormalizeProducts, msNormalizeParts, msParsePrice, mergePartResults, dkFmtPrice, partQueryFor, searchOptions,
};
