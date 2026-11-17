"use strict";
/*
 * playltc deposit backend (Vercel serverless function, route: /api/deposit)
 *
 * Flow
 *  1. Logged-in user asks for a deposit of $X  -> action "create"
 *     We quote LTC at the current price and add a tiny unique number of litoshis,
 *     so every open deposit has its own exact LTC amount.
 *  2. The user sends exactly that amount to WALLET.
 *  3. The page calls action "check" every ~10s while a deposit is open. Every check
 *     (and the optional cron "sweep") looks at the wallet's transactions and credits
 *     any confirmed payment whose amount matches an open deposit exactly.
 *
 * Balances are only ever written here, with the Firebase Admin SDK. Never from the browser.
 *
 * Env vars (Vercel -> Project -> Settings -> Environment Variables)
 *   FIREBASE_SERVICE_ACCOUNT  the whole service-account JSON, pasted as one value
 *   FIREBASE_DB_URL           optional, defaults to the playltcwtf database
 *   CRON_SECRET               optional, enables the "sweep" action for the GitHub cron
 */

const WALLET = "LbJjLAgrb28BgnnjF1s85ffrRBNYDkchpn";
const MIN_USD = 0.25;
const MAX_USD = 1000;
const SEND_WINDOW_MS = 30 * 60 * 1000; // time the user has to send the payment
const CONFIRM_GRACE_S = 30 * 60;       // a payment sent in time may confirm this long after the window
const MAX_OPEN = 3;                    // open deposits per user
const FETCH_MS = 7000;
const TIERS = [["Bronze", 2], ["Silver", 5], ["Gold", 10], ["Platinum", 15], ["Diamond", 20], ["High Roller", 25], ["Whale", 35]];

let admin = null;
function init() {
  if (!admin) {
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        databaseURL: process.env.FIREBASE_DB_URL || "https://playltcwtf-default-rtdb.firebaseio.com"
      });
    }
  }
  return admin;
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}

async function ltcPrice() {
  try {
    const d = await getJson("https://api.coinbase.com/v2/prices/LTC-USD/spot");
    const p = parseFloat(d.data.amount);
    if (p > 0) return p;
  } catch (e) { /* fall through to the backup source */ }
  const d = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd");
  const p = Number(d.litecoin.usd);
  if (!(p > 0)) throw new Error("no price");
  return p;
}

// Transactions paying WALLET, in one shape no matter which explorer answered.
let txCache = { at: 0, txs: [] };
async function walletTxs() {
  if (Date.now() - txCache.at < 7000) return txCache.txs;
  let txs;
  try {
    const raw = await getJson("https://litecoinspace.org/api/address/" + WALLET + "/txs");
    txs = raw.map(function (t) {
      return {
        id: t.txid,
        confirmed: !!(t.status && t.status.confirmed),
        time: (t.status && t.status.block_time) || 0,
        outs: (t.vout || []).map(function (o, n) { return { n: n, addr: o.scriptpubkey_address, value: o.value }; })
          .filter(function (o) { return o.addr === WALLET; })
      };
    });
  } catch (e) {
    const raw = await getJson("https://api.blockcypher.com/v1/ltc/main/addrs/" + WALLET + "/full?limit=50");
    txs = (raw.txs || []).map(function (t) {
      return {
        id: t.hash,
        confirmed: (t.confirmations || 0) >= 1,
        time: t.confirmed ? Math.floor(Date.parse(t.confirmed) / 1000) : 0,
        outs: (t.outputs || []).map(function (o, n) { return { n: n, addrs: o.addresses || [], value: o.value }; })
          .filter(function (o) { return o.addrs.indexOf(WALLET) > -1; })
      };
    });
  }
  txCache = { at: Date.now(), txs: txs };
  return txs;
}

function flatten(tree) {
  const out = [];
  Object.keys(tree || {}).forEach(function (uid) {
    Object.keys(tree[uid] || {}).forEach(function (id) {
      const p = tree[uid][id];
      if (p && typeof p.ltc === "number") out.push({ uid: uid, id: id, usd: p.usd, ltc: p.ltc, created: p.created, exp: p.exp });
    });
  });
  return out;
}

// Pure: which confirmed outputs pay exactly an open deposit, and in the right time window.
function matchPayments(txs, pend) {
  const byLtc = new Map();
  pend.forEach(function (p) { byLtc.set(p.ltc, p); });
  const hits = [], misses = [];
  txs.forEach(function (tx) {
    if (!tx.confirmed) return;
    tx.outs.forEach(function (o) {
      const key = tx.id + "_" + o.n;
      const p = byLtc.get(o.value);
      const inWindow = p && tx.time >= Math.floor(p.created / 1000) - 120 && tx.time <= Math.floor(p.exp / 1000) + CONFIRM_GRACE_S;
      if (inWindow) hits.push({ key: key, p: p, tx: tx });
      else misses.push({ key: key, tx: tx, value: o.value });
    });
  });
  return { hits: hits, misses: misses };
}

async function credit(d, hit) {
  const p = hit.p;
  // Claim the transaction first. If two checks race, only one gets committed = true.
  const claim = await d.ref("processed/" + hit.key).transaction(function (c) {
    return c === null ? { uid: p.uid, usd: p.usd, pid: p.id, txid: hit.tx.id, at: Date.now() } : undefined;
  });
  if (!claim.committed) return null;

  await d.ref("balances/" + p.uid).transaction(function (b) {
    return Math.round(((Number(b) || 0) + p.usd) * 100) / 100;
  });
  const histId = d.ref("history/" + p.uid + "/deposits").push().key;
  await d.ref().update({
    ["history/" + p.uid + "/deposits/" + histId]: { method: "Litecoin", amount: p.usd, status: "Completed", ts: Date.now(), txid: hit.tx.id },
    ["pending/" + p.uid + "/" + p.id]: null
  });

  // Total deposited + automatic roles (Bronze $2 ... Whale $35).
  const nameSnap = await d.ref("users/" + p.uid + "/username").once("value");
  const name = String(nameSnap.val() || "").toLowerCase();
  if (/^[a-z0-9_]{3,16}$/.test(name)) {
    const tot = await d.ref("deposits/" + name).transaction(function (t) {
      return Math.round(((Number(t) || 0) + p.usd) * 100) / 100;
    });
    const total = Number(tot.snapshot.val()) || 0;
    const patch = {};
    TIERS.forEach(function (t) { patch[t[0]] = total >= t[1] ? true : null; });
    await d.ref("badges/" + name).update(patch);
  }
  return { uid: p.uid, usd: p.usd, txid: hit.tx.id };
}

async function sweep(d, force) {
  const now = Date.now();
  const snap = await d.ref("pending").once("value");
  const all = flatten(snap.val());
  const live = all.filter(function (p) { return now <= p.exp + CONFIRM_GRACE_S * 1000; });

  // Drop deposits that can no longer match anything.
  const dead = {};
  all.forEach(function (p) { if (!live.includes(p)) dead["pending/" + p.uid + "/" + p.id] = null; });
  if (Object.keys(dead).length) await d.ref().update(dead);

  if (!live.length && !force) return [];
  const txs = await walletTxs();
  const m = matchPayments(txs, live);

  const done = [];
  for (const hit of m.hits) {
    const c = await credit(d, hit);
    if (c) done.push(c);
  }
  // Payments we could not match (wrong amount, late, no open deposit): log once for you to review.
  for (const x of m.misses.slice(0, 25)) {
    await d.ref("unmatched/" + x.key).transaction(function (c) {
      return c === null ? { txid: x.tx.id, litoshis: x.value, ltc: x.value / 1e8, blockTime: x.tx.time, seen: Date.now() } : undefined;
    });
  }
  return done;
}

async function state(d, uid) {
  const now = Date.now();
  const nameSnap = await d.ref("users/" + uid + "/username").once("value");
  const name = String(nameSnap.val() || "").toLowerCase();
  const [bal, hist, pend, dep] = await Promise.all([
    d.ref("balances/" + uid).once("value"),
    d.ref("history/" + uid + "/deposits").orderByKey().limitToLast(50).once("value"),
    d.ref("pending/" + uid).once("value"),
    /^[a-z0-9_]{3,16}$/.test(name) ? d.ref("deposits/" + name).once("value") : Promise.resolve({ val: function () { return 0; } })
  ]);
  const history = [];
  hist.forEach(function (c) { const v = c.val(); if (v) history.push({ method: v.method, amount: v.amount, status: v.status, ts: v.ts }); });
  const pending = flatten({ [uid]: pend.val() || {} })
    .filter(function (p) { return now <= p.exp + CONFIRM_GRACE_S * 1000; })
    .sort(function (a, b) { return a.created - b.created; })
    .map(function (p) { return { id: p.id, usd: p.usd, ltc: p.ltc, created: p.created, exp: p.exp }; });
  return { balance: Number(bal.val()) || 0, deposited: Number(dep.val()) || 0, history: history, pending: pending, address: WALLET };
}

async function create(d, uid, usd) {
  if (!(usd >= MIN_USD && usd <= MAX_USD)) throw httpErr(400, "Deposit between $" + MIN_USD.toFixed(2) + " and $" + MAX_USD + ".");
  usd = Math.round(usd * 100) / 100;
  const now = Date.now();
  const all = flatten((await d.ref("pending").once("value")).val());
  const mine = all.filter(function (p) { return p.uid === uid && now <= p.exp; });
  if (mine.length >= MAX_OPEN) throw httpErr(400, "You already have " + MAX_OPEN + " open deposits. Cancel one first.");

  const base = Math.round(usd / (await ltcPrice()) * 1e8);
  const spread = Math.max(200, Math.min(9999, Math.floor(base * 0.01)));
  const used = new Set(all.map(function (p) { return p.ltc; }));
  let ltc = 0;
  for (let i = 0; i < 100; i++) {
    ltc = base + 1 + Math.floor(Math.random() * spread); // small unique tag, at most about 1% of the deposit
    if (!used.has(ltc)) break;
    ltc = 0;
  }
  if (!ltc) throw httpErr(503, "Try again in a moment.");
  await d.ref("pending/" + uid).push({ usd: usd, ltc: ltc, created: now, exp: now + SEND_WINDOW_MS });
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const a = init();
    const d = a.database();
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // Background sweep (GitHub cron). Credits payments even when nobody has the page open.
    if (body.action === "sweep") {
      if (!process.env.CRON_SECRET || req.headers["x-cron-secret"] !== process.env.CRON_SECRET) throw httpErr(401, "no");
      const done = await sweep(d, true);
      return res.status(200).json({ ok: true, credited: done.length });
    }

    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) throw httpErr(401, "Log in first.");
    let uid;
    try { uid = (await a.auth().verifyIdToken(m[1])).uid; } catch (e) { throw httpErr(401, "Log in again."); }

    if (body.action === "create") await create(d, uid, Number(body.usd));
    else if (body.action === "cancel") {
      if (typeof body.id !== "string" || !/^[-\w]{10,40}$/.test(body.id)) throw httpErr(400, "Bad id.");
      await d.ref("pending/" + uid + "/" + body.id).remove();
    } else if (body.action !== "check") throw httpErr(400, "Unknown action.");

    // Look for payments (any user's check credits everyone's). Limited to one run per 3s per user.
    let credited = [];
    if (body.action !== "cancel") {
      const rl = await d.ref("rl/" + uid).transaction(function (t) { return Date.now() - (Number(t) || 0) < 3000 ? undefined : Date.now(); });
      if (rl.committed || body.action === "create") credited = await sweep(d, false);
    }
    const out = await state(d, uid);
    out.credited = credited.filter(function (c) { return c.uid === uid; }).map(function (c) { return { usd: c.usd }; });
    return res.status(200).json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return res.status(status).json({ error: status === 500 ? "Something went wrong. Try again." : e.message });
  }
}

module.exports = handler;
module.exports.matchPayments = matchPayments;
