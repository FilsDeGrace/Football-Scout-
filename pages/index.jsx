import { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────────
const LS = {
  get: (k, fb = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  raw: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  rawSet: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const TODAY = new Date().toISOString().split("T")[0];
const DATE_LABEL = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const BATCH_SIZE = 8;
const CONF_FLOOR = 60; // minimum confidence for Best Conf acca
const CRAZY_CONF_FLOOR = 45; // minimum confidence for Crazy Parlay

function csvHash(s) {
  let h = 0;
  for (let i = 0; i < Math.min(s.length, 500); i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return h.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────────────
// Value score: conf × ln(odds) — rewards value, penalises short prices
function valueScore(conf, odds) {
  const o = parseFloat(odds);
  if (!o || o <= 1.01) return 0;
  return parseFloat(((conf / 100) * Math.log(o)).toFixed(4));
}

// EV: (prob × odds) - 1
function calcEV(prob100, odds) {
  const o = parseFloat(odds);
  if (!o || o <= 1) return null;
  return parseFloat(((prob100 / 100) * o - 1).toFixed(3));
}

// Edge vs bookmaker (conf% - implied%)
function calcEdge(conf, realOdds) {
  const o = parseFloat(realOdds);
  if (!o || o <= 1) return null;
  return Math.round(conf - (1 / o) * 100);
}

// EV flag tier
function evFlag(ev) {
  if (ev === null) return null;
  if (ev > 0.05) return "BET";
  if (ev >= 0) return "MAYBE";
  return "SKIP";
}

// Signal quality 1–10
function signalScore(m) {
  let s = 0;
  if (m.ppgHome) s++;
  if (m.ppgAway) s++;
  if (m.ou25) s++;
  if (m.btts) s++;
  if (m.hcs && m.acs) s++;
  if (m.xgDelta && parseFloat(m.xgDelta) !== 0) s++;
  if (m.odds1) s += 1.5;
  if (m.oddsOver25) s += 0.5;
  if (m.oddsGGYes) s += 0.5;
  return Math.min(10, Math.round(s * 1.3));
}

// Pre-pass EV for O2.5 and BTTS from raw CSV data
function preCalcEV(m) {
  const ou25prob = parseFloat((m.ou25 || "").replace("%", "")) || 0;
  const bttsProb = parseFloat((m.btts || "").replace("%", "")) || 0;
  const ev_o25 = m.oddsOver25 ? calcEV(ou25prob, m.oddsOver25) : null;
  const ev_btts = m.oddsGGYes ? calcEV(bttsProb, m.oddsGGYes) : null;
  return {
    ev_o25,
    ev_btts,
    flag_o25: evFlag(ev_o25),
    flag_btts: evFlag(ev_btts),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLICT DETECTORS
// These run on raw CSV data BEFORE the model, flagging stats that contradict
// each other so the API prompt already knows what to adjust.
// ─────────────────────────────────────────────────────────────────────────────
function detectConflicts(m) {
  const conflicts = [];
  const hcs = parseFloat((m.hcs || "").replace("%", "")) || 0;
  const acs = parseFloat((m.acs || "").replace("%", "")) || 0;
  const afts = parseFloat((m.afts || "").replace("%", "")) || 0;
  const hfts = parseFloat((m.hfts || "").replace("%", "")) || 0;
  const ou25 = parseFloat((m.ou25 || "").replace("%", "")) || 0;
  const btts = parseFloat((m.btts || "").replace("%", "")) || 0;
  const xgd = parseFloat(m.xgDelta) || 0;
  const ppgH = parseFloat(m.ppgHome) || 0;
  const ppgA = parseFloat(m.ppgAway) || 0;
  const avgGls = parseFloat(m.avgGoals) || 0;

  // BTTS TRAP: home keeps sheets + away rarely scores = BTTS overrated
  if (hcs >= 35 && afts >= 25) {
    conflicts.push({ key: "BTTS_TRAP", label: "BTTS TRAP", desc: `H.CS ${hcs}% + A.FTS ${afts}% — BTTS likely overrated`, cls: "tg-r", adjust: "btts_down" });
  }
  // OVER TRAP: high O2.5 but low avg goals = stats contradict
  if (ou25 >= 70 && avgGls > 0 && avgGls < 2.0) {
    conflicts.push({ key: "OVER_TRAP", label: "OVER TRAP", desc: `O2.5 ${ou25}% but avg goals only ${avgGls} — Over may be overrated`, cls: "tg-r", adjust: "over_down" });
  }
  // xG SURGE: strong xG gap = overs underrated
  if (xgd >= 0.5) {
    conflicts.push({ key: "XG_SURGE", label: "xG SURGE", desc: `xG.Delta +${xgd} — chance creation strongly favours home, boost overs`, cls: "tg-a", adjust: "over_up" });
  }
  // FORM GAP: big PPG difference
  if (ppgH > 0 && ppgA > 0 && Math.abs(ppgH - ppgA) >= 1.5) {
    const fav = ppgH > ppgA ? "Home" : "Away";
    conflicts.push({ key: "FORM_GAP", label: "FORM GAP", desc: `${fav} PPG gap ${Math.abs(ppgH - ppgA).toFixed(1)} — strong form mismatch`, cls: "tg-p", adjust: "result_boost" });
  }
  // CLEAN SHEET BOTH: both teams defending well = low scoring game likely
  if (hcs >= 35 && acs >= 35) {
    conflicts.push({ key: "LOW_SCORING", label: "LOW SCORE", desc: `Both CS% high (H:${hcs}% A:${acs}%) — Under 2.5 likely`, cls: "tg-b", adjust: "under_up" });
  }
  // HIGH VALUE: BTTS + Over both high = open game
  if (btts >= 65 && ou25 >= 70) {
    conflicts.push({ key: "HIGH_VALUE", label: "HIGH VALUE", desc: `BTTS ${btts}% + O2.5 ${ou25}% — open game, both markets strong`, cls: "tg-g", adjust: "none" });
  }
  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCA PICK: highest-confidence market ≥ CONF_FLOOR on a result
// Different from Best Bet (value). This is what you trust to WIN.
// ─────────────────────────────────────────────────────────────────────────────
function getAccaPick(result) {
  if (!result?.markets) return null;
  const candidates = Object.entries(result.markets)
    .map(([key, m]) => ({ key, ...m }))
    .filter(m => m.conf >= CONF_FLOOR && parseFloat(m.odds) > 1.05)
    .sort((a, b) => b.conf - a.conf);
  if (!candidates.length) return null;
  const mktLabel = { result: "Result", btts: "BTTS", ou25: "O/U 2.5", ou15: "O/U 1.5", doubleChance: "DC", ou35: "O/U 3.5", drawNoBet: "DNB", asianHandicap: "Asian HC", htResult: "Half-Time", winToNil: "Win to Nil", totalGoalsRange: "Goals Range" };
  const best = candidates[0];
  return { pick: best.pick, market: mktLabel[best.key] || best.key, conf: best.conf, odds: best.odds, source: best.source };
}

// Crazy parlay pick: best value score with conf >= CRAZY_CONF_FLOOR
function getCrazyPick(result) {
  if (!result?.markets) return null;
  const candidates = Object.entries(result.markets)
    .map(([key, m]) => ({ key, ...m, score: valueScore(m.conf, m.odds) }))
    .filter(m => m.conf >= CRAZY_CONF_FLOOR && parseFloat(m.odds) > 1.20 && m.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  const mktLabel = { result: "Result", btts: "BTTS", ou25: "O/U 2.5", ou15: "O/U 1.5", doubleChance: "DC", ou35: "O/U 3.5", drawNoBet: "DNB", asianHandicap: "Asian HC", htResult: "Half-Time", winToNil: "Win to Nil", totalGoalsRange: "Goals Range" };
  const best = candidates[0];
  return { pick: best.pick, market: mktLabel[best.key] || best.key, conf: best.conf, odds: best.odds, source: best.source, score: best.score };
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const S = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#05080b;color:#d8e4ec;font-family:'Syne',sans-serif;-webkit-font-smoothing:antialiased}
:root{--g:#00e87a;--a:#ffb545;--r:#ff4f5e;--b:#3d9eff;--p:#b57bee;--c:#ff6ef7;--s1:#0b1318;--s2:#0f1b22;--s3:#162028;--bd:#1a2e3a;--mu:#3a5568;--mono:'IBM Plex Mono',monospace}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#05080b}::-webkit-scrollbar-thumb{background:var(--bd)}
.app{min-height:100vh;max-width:860px;margin:0 auto;display:flex;flex-direction:column;padding-bottom:56px}
.topbar{display:flex;align-items:center;padding:11px 16px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:#05080b;z-index:60;gap:10px}
.logo{font-size:15px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#fff}
.logo em{color:var(--g);font-style:normal}
.topbar-date{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--mu)}
.sbar{display:flex;align-items:center;gap:8px;padding:6px 16px;background:var(--s1);border-bottom:1px solid var(--bd);font-family:var(--mono);font-size:11px;color:var(--g);min-height:30px}
.pulse{width:6px;height:6px;border-radius:50%;background:var(--g);animation:pl 1.2s infinite;flex-shrink:0}
@keyframes pl{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.5)}}
.ebar{padding:6px 16px;background:#150508;border-bottom:1px solid #3a0e15;font-family:var(--mono);font-size:11px;color:var(--r)}
.screen{padding:14px 16px}
.bbar{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:9px 13px;margin:0 16px 8px}
.bbar-h{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;margin-bottom:5px}
.bbar-t{color:var(--g);letter-spacing:1px}.bbar-m{color:var(--mu)}
.prog{height:3px;background:#0a1218;border-radius:2px;overflow:hidden}
.prog-f{height:100%;background:var(--g);border-radius:2px;transition:width .4s ease}
.sec-lbl{font-family:var(--mono);font-size:8px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mu);margin:16px 0 9px;padding-bottom:5px;border-bottom:1px solid var(--bd)}

/* CSV */
.csv-panel{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:12px}
.csv-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;gap:8px;flex-wrap:wrap}
.csv-ttl{font-size:14px;font-weight:800;color:#fff}
.csv-sub{font-family:var(--mono);font-size:10px;color:var(--mu);margin-top:2px}
.sv-badge{background:#031a0c;border:1px solid rgba(0,232,122,.3);color:var(--g);font-family:var(--mono);font-size:9px;padding:3px 8px;border-radius:3px;letter-spacing:1px;white-space:nowrap}
.csv-ta{width:100%;background:#05080b;border:1px solid var(--bd);border-radius:5px;color:#d8e4ec;font-family:var(--mono);font-size:11px;padding:9px 11px;resize:vertical;min-height:75px;max-height:150px;outline:none;line-height:1.6;transition:border-color .2s;margin-bottom:8px}
.csv-ta:focus{border-color:var(--g)}
.csv-ta::placeholder{color:#1a3040}
.csv-acts{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.csv-hint{font-family:var(--mono);font-size:9px;color:var(--mu)}
.csv-hint em{color:var(--g);font-style:normal}

/* MATCH LIST */
.lh{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px}
.lh-t{font-size:14px;font-weight:800;color:#fff}
.lh-m{font-family:var(--mono);font-size:10px;color:var(--mu)}
.lh-acts{display:flex;gap:5px}
.mrow{display:flex;align-items:center;gap:8px;padding:8px 11px;background:var(--s1);border:1px solid var(--bd);border-radius:7px;margin-bottom:4px;cursor:pointer;transition:border-color .12s;user-select:none}
.mrow:hover{border-color:var(--mu)}.mrow.sel{border-color:var(--g);background:#021408}
.mrow.trap{border-left:3px solid var(--r)}.mrow.surge{border-left:3px solid var(--a)}.mrow.value{border-left:3px solid var(--g)}
.mt{flex:1;min-width:0}
.mh{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mvs{font-family:var(--mono);font-size:8px;color:var(--mu);letter-spacing:1px;margin:1px 0}
.ma{font-size:11px;color:var(--mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-meta{display:flex;gap:6px;margin-top:3px;flex-wrap:wrap;align-items:center}
.m-sig{font-family:var(--mono);font-size:9px;color:var(--mu)}
.m-sig em{color:var(--g);font-style:normal}
.m-ev{font-family:var(--mono);font-size:9px;font-weight:700}
.mtags{display:flex;gap:3px;flex-wrap:wrap;max-width:130px;justify-content:flex-end;flex-shrink:0}
.tg{font-family:var(--mono);font-size:7px;padding:2px 5px;border-radius:3px;font-weight:700;white-space:nowrap;letter-spacing:.3px}
.tg-g{background:#021408;color:var(--g)}.tg-a{background:#1a1000;color:var(--a)}.tg-r{background:#1a0408;color:var(--r)}.tg-b{background:#080f1e;color:var(--b)}.tg-p{background:#100818;color:var(--p)}
.mcb{width:15px;height:15px;border-radius:3px;border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;transition:all .15s;color:transparent}
.mrow.sel .mcb{background:var(--g);border-color:var(--g);color:#000}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;font-family:'Syne',sans-serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;border-radius:5px;cursor:pointer;transition:all .15s;border:none;white-space:nowrap}
.btn-g{background:var(--g);color:#000}.btn-g:hover:not(:disabled){background:#05ffaa;transform:translateY(-1px)}
.btn-g:disabled{background:var(--bd);color:var(--mu);cursor:not-allowed;transform:none}
.btn-o{background:transparent;color:var(--mu);border:1px solid var(--bd)}.btn-o:hover{border-color:var(--mu);color:#d8e4ec}
.btn-r{background:transparent;color:var(--r);border:1px solid #3a0e15}
.btn-sm{padding:5px 11px;font-size:11px}

/* ANALYZE BAR */
.abar{position:fixed;bottom:56px;left:50%;transform:translateX(-50%);width:100%;max-width:860px;background:#05080b;border-top:1px solid var(--bd);padding:9px 16px;display:flex;align-items:center;justify-content:space-between;z-index:80;gap:10px}
.abar-l{display:flex;flex-direction:column;gap:1px}
.abar-c{font-family:var(--mono);font-size:11px;color:var(--mu)}
.abar-c em{color:var(--g);font-style:normal;font-weight:600}
.abar-b{font-family:var(--mono);font-size:9px;color:var(--mu)}
.abar-r{display:flex;gap:7px}

/* SHORTLIST */
.shortlist{background:var(--s1);border:1px solid rgba(0,232,122,.2);border-radius:9px;padding:13px;margin-bottom:12px}
.shortlist-t{font-size:14px;font-weight:800;color:var(--g)}
.shortlist-s{font-family:var(--mono);font-size:9px;color:var(--mu);margin:3px 0 10px}
.sl-row{display:flex;align-items:center;gap:9px;padding:8px 10px;background:var(--s2);border-radius:6px;margin-bottom:4px;cursor:pointer;border:1px solid transparent;transition:border-color .12s}
.sl-row:hover{border-color:var(--bd)}
.sl-rank{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--mu);width:18px;flex-shrink:0}
.sl-body{flex:1;min-width:0}
.sl-match{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}
.sl-pick{font-family:var(--mono);font-size:10px;color:var(--g);margin-top:1px}
.sl-bar{height:2px;background:var(--bd);border-radius:2px;overflow:hidden;margin-top:3px}
.sl-fill{height:100%;border-radius:2px}
.sl-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.sl-num{font-family:var(--mono);font-size:11px;font-weight:700}
.sl-odds{font-family:var(--mono);font-size:13px;color:var(--a);font-weight:700}

/* EDGE BOARD */
.edgeboard{background:var(--s1);border:1px solid rgba(255,181,69,.15);border-radius:9px;padding:13px;margin-bottom:12px}
.edgeboard-t{font-size:14px;font-weight:800;color:var(--a)}
.edgeboard-s{font-family:var(--mono);font-size:9px;color:var(--mu);margin:3px 0 10px}
.edge-row{display:flex;align-items:center;gap:9px;padding:8px 10px;background:var(--s2);border-radius:6px;margin-bottom:4px;cursor:pointer;border:1px solid transparent;transition:border-color .12s}
.edge-row:hover{border-color:var(--bd)}
.edge-rank{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--mu);width:18px;flex-shrink:0}
.edge-body{flex:1;min-width:0}
.edge-match{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}
.edge-pick{font-family:var(--mono);font-size:10px;color:var(--a);margin-top:1px}
.edge-bar{height:2px;background:var(--bd);border-radius:2px;overflow:hidden;margin-top:3px}
.edge-fill{height:100%;border-radius:2px;background:var(--a)}
.edge-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.edge-pct{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--g)}
.edge-odds{font-family:var(--mono);font-size:13px;color:var(--a);font-weight:700}
.no-board-msg{font-family:var(--mono);font-size:11px;color:var(--mu);padding:4px 0}

/* CARDS */
.card{background:var(--s1);border:1px solid var(--bd);border-radius:9px;margin-bottom:8px;overflow:hidden;animation:fu .2s ease}
@keyframes fu{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.card.deep{border-color:var(--b)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;padding:10px 12px;background:var(--s2);border-bottom:1px solid var(--bd);gap:8px;flex-wrap:wrap}
.card-match{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#fff}
.card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:4px}
.card-league{font-family:var(--mono);font-size:9px;color:var(--mu);letter-spacing:1px}
.sig-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.sig-lbl{font-family:var(--mono);font-size:9px;color:var(--mu)}
.card-body{padding:11px 12px}

/* BEST BET BOX */
.best-box{background:#021408;border:1px solid rgba(0,232,122,.2);border-radius:6px;padding:10px 12px;margin-bottom:8px}
.best-lbl{font-family:var(--mono);font-size:7px;letter-spacing:2.5px;text-transform:uppercase;color:var(--g);margin-bottom:4px}
.best-pick{font-size:17px;font-weight:800;color:var(--g);line-height:1;margin-bottom:2px}
.best-meta{font-family:var(--mono);font-size:10px;color:#2a6a45}
.best-why{font-family:var(--mono);font-size:10px;color:#2a5a3a;line-height:1.6;margin-top:3px}
.best-score-row{display:flex;align-items:center;gap:7px;margin-top:5px}
.best-score-lbl{font-family:var(--mono);font-size:8px;color:var(--mu);letter-spacing:1px}
.best-score-val{font-family:var(--mono);font-size:10px;font-weight:700;color:var(--g)}
.best-score-track{flex:1;height:2px;background:var(--bd);border-radius:2px;overflow:hidden}
.best-score-fill{height:100%;background:var(--g);border-radius:2px}

/* EDGE BET BOX */
.edge-box{background:#120900;border:1px solid rgba(255,181,69,.2);border-radius:6px;padding:10px 12px;margin-bottom:8px}
.edge-lbl{font-family:var(--mono);font-size:7px;letter-spacing:2.5px;text-transform:uppercase;color:var(--a);margin-bottom:4px}
.edge-pick-big{font-size:17px;font-weight:800;color:var(--a);line-height:1;margin-bottom:2px}
.edge-meta{font-family:var(--mono);font-size:10px;color:#7a5a20}
.edge-pct-row{font-family:var(--mono);font-size:10px;color:var(--a);font-weight:700;margin-top:2px}
.edge-why-txt{font-family:var(--mono);font-size:10px;color:#6a5020;line-height:1.6;margin-top:3px}
.no-edge-box{background:#0a1018;border:1px dashed var(--bd);border-radius:6px;padding:10px 12px;margin-bottom:8px;opacity:.4}
.no-edge-lbl{font-family:var(--mono);font-size:7px;letter-spacing:2.5px;text-transform:uppercase;color:var(--mu);margin-bottom:4px}
.no-edge-txt{font-family:var(--mono);font-size:10px;color:var(--mu)}

/* MARKETS */
.mkts-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:8px}
.mkt{background:#070f14;border:1px solid var(--bd);border-radius:5px;padding:6px 7px;text-align:center}
.mkt.hot{border-color:rgba(0,232,122,.3)}.mkt.book{border-color:rgba(255,181,69,.2)}
.mkt-l{font-family:var(--mono);font-size:7px;letter-spacing:.8px;text-transform:uppercase;color:var(--mu);margin-bottom:2px}
.mkt-v{font-size:13px;font-weight:800;line-height:1}
.mkt-c{font-family:var(--mono);font-size:9px;font-weight:600;margin-top:1px}
.mkt-o{font-family:var(--mono);font-size:9px;color:var(--a);margin-top:1px}
.mkt-src{font-family:var(--mono);font-size:7px;color:var(--mu)}
.bars{margin-bottom:8px}
.bar-r{margin-bottom:4px}
.bar-h{display:flex;justify-content:space-between;font-family:var(--mono);font-size:8px;margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px;color:var(--mu)}
.track{height:3px;background:#0a1218;border-radius:2px;overflow:hidden}
.fill{height:100%;border-radius:2px;transition:width .9s cubic-bezier(.16,1,.3,1)}
.om-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px}
.om{display:flex;align-items:center;justify-content:space-between;background:#070f14;border:1px solid var(--bd);border-radius:4px;padding:5px 8px}
.om.hot{border-color:rgba(0,232,122,.15)}
.om-l{font-family:var(--mono);font-size:9px;color:var(--mu)}
.om-r{display:flex;align-items:center;gap:4px}
.om-v{font-size:12px;font-weight:700}
.om-c{font-family:var(--mono);font-size:9px;color:var(--mu)}
.om-o{font-family:var(--mono);font-size:9px;color:var(--a)}
.odds-panel{background:#070f14;border:1px solid var(--bd);border-radius:5px;padding:8px 11px;margin-bottom:8px}
.odds-panel-t{font-family:var(--mono);font-size:7px;letter-spacing:2px;text-transform:uppercase;color:var(--mu);margin-bottom:7px}
.odds-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
.oc{text-align:center}
.oc-l{font-family:var(--mono);font-size:8px;color:var(--mu);margin-bottom:2px}
.oc-v{font-size:14px;font-weight:800;color:var(--a)}
.oc-i{font-family:var(--mono);font-size:9px;color:var(--mu)}
.conflict-box{background:#120800;border:1px solid rgba(255,181,69,.12);border-radius:5px;padding:8px 10px;margin-bottom:8px}
.conflict-lbl{font-family:var(--mono);font-size:7px;letter-spacing:2px;text-transform:uppercase;color:var(--a);margin-bottom:4px}
.conflict-item{font-family:var(--mono);font-size:9px;color:#6a5020;line-height:1.7;padding:1px 0}
.stats-sec{border-top:1px solid var(--bd);padding-top:10px;margin-top:10px}
.stats-sec-l{font-family:var(--mono);font-size:7px;letter-spacing:2px;text-transform:uppercase;color:var(--mu);margin-bottom:7px}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.stat-box{background:#070f14;border:1px solid var(--bd);border-radius:5px;padding:8px}
.stat-box-t{font-family:var(--mono);font-size:7px;letter-spacing:2px;text-transform:uppercase;color:var(--g);margin-bottom:5px}
.stat-row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #0b1620}
.stat-row:last-child{border-bottom:none}
.stat-k{font-family:var(--mono);font-size:9px;color:var(--mu)}
.stat-v{font-family:var(--mono);font-size:9px;font-weight:700;color:#d8e4ec;text-align:right;max-width:55%}
.h2h-full{grid-column:1/-1}
.rsn{font-family:var(--mono);font-size:11px;color:#3a6070;line-height:1.8;margin-top:3px}
.deep-btn{background:transparent;border:1px solid var(--b);color:var(--b);font-family:var(--mono);font-size:9px;padding:4px 9px;border-radius:4px;cursor:pointer;letter-spacing:1px;text-transform:uppercase;transition:all .15s;white-space:nowrap}
.deep-btn:hover{background:var(--b);color:#000}.deep-btn.done{border-color:var(--g);color:var(--g)}
.deep-btn:disabled{opacity:.4;cursor:not-allowed}
.card-foot{display:flex;align-items:center;justify-content:space-between;margin-top:9px;padding-top:9px;border-top:1px solid var(--bd)}
.card-foot-note{font-family:var(--mono);font-size:8px;color:var(--mu)}

/* ACCA */
.acca-tabs{display:flex;gap:0;background:var(--s1);border:1px solid var(--bd);border-radius:8px;overflow:hidden;margin-bottom:13px}
.acca-tab{flex:1;padding:9px 5px;background:transparent;border:none;color:var(--mu);cursor:pointer;font-family:'Syne',sans-serif;font-size:11px;font-weight:700;letter-spacing:.5px;text-align:center;transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:2px;border-right:1px solid var(--bd)}
.acca-tab:last-child{border-right:none}
.acca-tab.on{background:var(--s2);color:#fff}
.acca-tab-i{font-size:14px;line-height:1}
.acca-tab-l{font-size:9px}
.acca-wrap{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:14px;margin-bottom:14px}
.acca-title{font-size:15px;font-weight:800;color:#fff;margin-bottom:2px}
.acca-sub{font-family:var(--mono);font-size:10px;color:var(--mu);margin-bottom:12px}
.slider-row{display:flex;align-items:center;gap:11px;background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:9px 13px;margin-bottom:12px}
.slider-lbl{font-family:var(--mono);font-size:10px;color:var(--mu);white-space:nowrap}
.slider-lbl em{color:var(--g);font-style:normal;font-weight:700;font-size:14px}
input[type=range]{flex:1;-webkit-appearance:none;appearance:none;height:3px;background:var(--bd);border-radius:2px;outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--g);cursor:pointer;border:2px solid #05080b}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--g);cursor:pointer;border:2px solid #05080b}
.slider-max{font-family:var(--mono);font-size:10px;color:var(--mu)}
.acca-leg{display:flex;align-items:center;justify-content:space-between;background:var(--s2);border:1px solid var(--bd);border-radius:5px;padding:8px 10px;margin-bottom:4px;gap:7px;flex-wrap:wrap}
.al-num{font-family:var(--mono);font-size:10px;color:var(--mu);width:16px;flex-shrink:0}
.al-body{flex:1;min-width:0}
.al-match{font-size:12px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.al-pick{font-family:var(--mono);font-size:10px;margin-top:1px}
.al-conf{font-family:var(--mono);font-size:9px;color:var(--mu);margin-top:1px}
.al-odds{font-family:var(--mono);font-size:14px;font-weight:700;color:var(--a);flex-shrink:0}
.acca-hr{border:none;border-top:1px solid var(--bd);margin:11px 0}
.acca-totals{display:flex;gap:13px;flex-wrap:wrap;margin-bottom:12px}
.acca-stat .al{font-family:var(--mono);font-size:7px;color:var(--mu);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px}
.acca-stat .av{font-size:19px;font-weight:800}
.stake-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.stake-lbl{font-family:var(--mono);font-size:10px;color:var(--mu)}
.stake-input{background:#070f14;border:1px solid var(--bd);border-radius:4px;color:var(--a);font-family:var(--mono);font-size:13px;font-weight:700;padding:5px 10px;width:125px;outline:none;transition:border-color .2s}
.stake-input:focus{border-color:var(--a)}
.ret-wrap{display:flex;gap:12px;margin-left:auto;flex-wrap:wrap}
.ri .rl{font-family:var(--mono);font-size:7px;color:var(--mu);letter-spacing:1px;text-transform:uppercase;margin-bottom:2px}
.ri .rv{font-size:17px;font-weight:800}
.acca-kick{background:#120800;border:1px solid rgba(255,79,94,.12);border-radius:5px;padding:7px 10px;margin-bottom:9px;font-family:var(--mono);font-size:10px;color:#7a3040}
.acca-kick em{color:var(--r);font-style:normal}
.acca-info{background:var(--s2);border:1px solid var(--bd);border-radius:5px;padding:9px 11px;margin-bottom:11px;font-family:var(--mono);font-size:10px;color:var(--mu);line-height:1.75}
.acca-info em{font-style:normal}
.no-acca{text-align:center;padding:28px 16px;color:var(--mu);font-family:var(--mono);font-size:11px;line-height:1.9}

/* TRACKER */
.tracker-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:12px}
.ts{background:var(--s1);border:1px solid var(--bd);border-radius:7px;padding:10px;text-align:center}
.ts-l{font-family:var(--mono);font-size:7px;letter-spacing:2px;text-transform:uppercase;color:var(--mu);margin-bottom:4px}
.ts-v{font-size:21px;font-weight:800}
.ts-s{font-family:var(--mono);font-size:9px;color:var(--mu);margin-top:1px}
.tracker-row{display:flex;align-items:center;gap:9px;padding:8px 11px;background:var(--s1);border:1px solid var(--bd);border-radius:7px;margin-bottom:4px;flex-wrap:wrap}
.tr-match{flex:1;min-width:0}
.tr-name{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr-pick{font-family:var(--mono);font-size:10px;color:var(--g);margin-top:1px}
.tr-date{font-family:var(--mono);font-size:9px;color:var(--mu);margin-top:1px}
.tr-odds{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--a);flex-shrink:0}
.tr-btns{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap}
.tr-btn{font-family:var(--mono);font-size:10px;padding:3px 9px;border-radius:4px;cursor:pointer;border:1px solid;font-weight:600;transition:all .15s;letter-spacing:.5px}
.tr-btn-w{border-color:rgba(0,232,122,.4);color:var(--g);background:transparent}.tr-btn-w:hover{background:var(--g);color:#000}
.tr-btn-l{border-color:rgba(255,79,94,.4);color:var(--r);background:transparent}.tr-btn-l:hover{background:var(--r);color:#fff}
.tr-btn-p{border-color:var(--bd);color:var(--mu);background:transparent}.tr-btn-p:hover{border-color:var(--mu);color:#fff}
.tr-result{font-family:var(--mono);font-size:11px;font-weight:700;padding:3px 9px;border-radius:4px;flex-shrink:0}
.tr-result-w{background:#021408;color:var(--g);border:1px solid rgba(0,232,122,.3)}
.tr-result-l{background:#150508;color:var(--r);border:1px solid rgba(255,79,94,.3)}
.tr-result-p{background:var(--s2);color:var(--mu);border:1px solid var(--bd)}
.tr-check-btn{font-family:var(--mono);font-size:9px;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid var(--b);color:var(--b);background:transparent;transition:all .15s;white-space:nowrap}
.tr-check-btn:hover{background:var(--b);color:#000}
.tr-check-btn:disabled{opacity:.4;cursor:not-allowed}
.tr-checking{font-family:var(--mono);font-size:9px;color:var(--mu);animation:pl 1s infinite}
.no-tracker{text-align:center;padding:28px 16px;color:var(--mu);font-family:var(--mono);font-size:11px;line-height:1.9}

/* SETTINGS */
.s-wrap{max-width:500px}
.s-blk{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:13px;margin-bottom:10px}
.s-blk-t{font-family:var(--mono);font-size:8px;letter-spacing:2px;text-transform:uppercase;color:var(--mu);margin-bottom:10px}
.s-text{font-family:var(--mono);font-size:11px;color:var(--mu);line-height:1.8;margin-bottom:10px}
.s-text em{color:var(--g);font-style:normal}
.prompt-box{background:#05080b;border:1px solid var(--bd);border-radius:5px;padding:10px;font-family:var(--mono);font-size:10px;color:#5a8090;line-height:1.75;margin-bottom:10px;user-select:all;cursor:text;white-space:pre-wrap;word-break:break-word}

/* NAV */
.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:860px;background:#05080b;border-top:1px solid var(--bd);display:flex;z-index:90}
.nb{flex:1;padding:9px 0;background:transparent;border:none;color:var(--mu);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;transition:color .15s;font-family:'Syne',sans-serif;font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.nb.on{color:var(--g)}.nb-i{font-size:13px;line-height:1}
.empty{text-align:center;padding:36px 16px;color:var(--mu)}
.empty .ei{font-size:32px;margin-bottom:9px}
.empty p{font-family:var(--mono);font-size:11px;line-height:1.8}
@media(max-width:480px){.tracker-stats{grid-template-columns:repeat(2,1fr)}.mkts-grid{grid-template-columns:repeat(2,1fr)}.stats-grid{grid-template-columns:1fr}.om-grid{grid-template-columns:1fr}.ret-wrap{margin-left:0}}
`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const gc = c => c >= 70 ? "var(--g)" : c >= 50 ? "var(--a)" : "var(--r)";
const sigColor = s => s >= 8 ? "#00e87a" : s >= 5 ? "#ffb545" : "#ff4f5e";
const oddsToImpl = o => o > 1 ? Math.round((1 / o) * 100) : 0;
const mktLabel = k => ({ result: "Result", btts: "BTTS", ou25: "O/U 2.5", ou15: "O/U 1.5", doubleChance: "DC", ou35: "O/U 3.5", drawNoBet: "DNB", asianHandicap: "Asian HC", htResult: "Half-Time", winToNil: "Win to Nil", totalGoalsRange: "Goals Range" }[k] || k);

function ConfBar({ label, pct, color }) {
  return (
    <div className="bar-r">
      <div className="bar-h"><span>{label}</span><span style={{ color, fontWeight: 700 }}>{pct}%</span></div>
      <div className="track"><div className="fill" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(raw) {
  if (!raw?.trim()) return [];
  const lines = raw.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  function normHeader(h) {
    const s = h.trim().toLowerCase().replace(/[\s().%]/g, "");
    if (s.includes("ppg") && (s.includes("home") || s.endsWith("h"))) return "ppghome";
    if (s.includes("ppg") && (s.includes("away") || s.endsWith("a"))) return "ppgaway";
    if (s.startsWith("h") && s.includes("o1") && s.includes("5")) return "hou15";
    if (s.startsWith("a") && s.includes("o1") && s.includes("5")) return "aou15";
    if (s.startsWith("h") && s.includes("o2") && s.includes("5")) return "hou25";
    if (s.startsWith("a") && s.includes("o2") && s.includes("5")) return "aou25";
    if (s.startsWith("h") && s.includes("cs")) return "hcs";
    if (s.startsWith("a") && s.includes("cs")) return "acs";
    if (s.startsWith("h") && s.includes("fts")) return "hfts";
    if (s.startsWith("a") && s.includes("fts")) return "afts";
    if (s.includes("o1") && s.includes("5") && !s.includes("odds") && !s.startsWith("h") && !s.startsWith("a")) return "ou15";
    if (s.includes("o2") && s.includes("5") && !s.includes("odds") && !s.startsWith("h") && !s.startsWith("a")) return "ou25";
    if (s.includes("o3") && s.includes("5") && !s.includes("odds")) return "ou35";
    if ((s.includes("btts") || s.includes("gg")) && !s.includes("odds")) return "btts";
    if (s.includes("xg")) return "xgdelta";
    if (s.includes("avgg") || s.includes("avggoal")) return "avggls";
    if (s.includes("odds") && s.endsWith("1") && !s.includes("1.5") && !s.includes("15")) return "odds1";
    if (s.includes("odds") && (s.endsWith("x") || s.endsWith("draw"))) return "oddsx";
    if (s.includes("odds") && s.endsWith("2") && !s.includes("2.5") && !s.includes("25")) return "odds2";
    if (s.includes("odds") && (s.includes("over") || s.includes("o25") || s.includes("o2.5"))) return "oddsover25";
    if (s.includes("odds") && (s.includes("under") || s.includes("u25") || s.includes("u2.5"))) return "oddsunder25";
    if (s.includes("odds") && (s.includes("gg") || s.includes("yes"))) return "oddsggyes";
    if (s.includes("odds") && s.includes("no")) return "oddsggnoo";
    if (s.includes("odds") && (s.includes("o1.5") || s.includes("o15"))) return "oddso15";
    if (s.includes("odds") && (s.includes("u1.5") || s.includes("u15"))) return "oddsu15";
    if (s === "date") return "date";
    if (s === "game" || s === "match" || s === "fixture") return "game";
    return s;
  }

  const headers = lines[0].split(",").map(normHeader);
  return lines.slice(1).map((line, idx) => {
    const vals = line.split(",").map(v => v.trim());
    const o = {};
    headers.forEach((h, i) => { o[h] = vals[i] || ""; });
    const gf = o["game"] || vals[0] || "";
    const pts = gf.split(/ vs\.? /i);
    const home = pts[0]?.trim(), away = pts[1]?.trim();
    if (!home || !away || home === away) return null;
    const base = {
      id: `m${idx}`, home, away,
      date: o.date || "",
      ppgHome: o.ppghome || "",
      ppgAway: o.ppgaway || "",
      btts: o.btts || "",
      ou15: o.ou15 || "",
      ou25: o.ou25 || "",
      ou35: o.ou35 || "",
      avgGoals: o.avggls || "",
      hcs: o.hcs || "", acs: o.acs || "",
      hfts: o.hfts || "", afts: o.afts || "",
      hou25: o.hou25 || "", aou25: o.aou25 || "",
      xgDelta: o.xgdelta || "",
      odds1: o.odds1 || "", oddsX: o.oddsx || "", odds2: o.odds2 || "",
      oddsOver25: o.oddsover25 || "", oddsUnder25: o.oddsunder25 || "",
      oddsGGYes: o.oddsggyes || "", oddsGGNo: o.oddsggnoo || "",
      oddsO15: o.oddso15 || "", oddsU15: o.oddsu15 || "",
    };
    base.signal = signalScore(base);
    base.conflicts = detectConflicts(base);
    base.preEV = preCalcEV(base);
    return base;
  }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text) throw new Error("Empty response");
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  const objects = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch {}
        start = -1;
      }
    }
  }
  if (objects.length > 0) return objects;
  throw new Error("No valid JSON found in response");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE API
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(system, user, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || "API error");
  const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return extractJSON(text);
}

async function checkResultOnline(matchName, matchDate) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: `Find a football match final score. Reply ONLY with JSON: {"homeScore":N,"awayScore":N,"status":"final"} or {"status":"not_found"}. Zero other text.`,
      messages: [{ role: "user", content: `Final score: ${matchName}${matchDate ? ` on ${matchDate}` : ""}` }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = text.match(/\{[^{}]*\}/);
  if (!m) return null;
  return JSON.parse(m[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS
// ─────────────────────────────────────────────────────────────────────────────
const GEMINI_PROMPT = `Role: Professional Football Data Analyst.
Task: Generate a CSV for today's football fixtures.

OUTPUT — first row must be EXACTLY this header, copied character-for-character:
Game,Date,PPG (Home),PPG (Away),H.O1.5%,A.O1.5%,O1.5%,H.O2.5%,A.O2.5%,O2.5%,BTTS%,H.CS%,A.CS%,H.FTS%,A.FTS%,xG.Delta,Avg.Gls,Odds.1,Odds.X,Odds.2,Odds.Over2.5,Odds.Under2.5,Odds.GG_Yes,Odds.GG_No,Odds.O1.5,Odds.U1.5

RULES:
1. Game: "Team A vs. Team B" — use " vs. " with period.
2. Date: YYYY-MM-DD.
3. Percentages: include % sign (e.g. 65%).
4. PPG: 2 decimal places. Use venue-specific stats (Home team HOME PPG, Away team AWAY PPG).
5. Odds: real average market odds, 2 decimal places. Never leave blank — estimate if needed.
6. xG.Delta: signed decimal e.g. +0.32 or -0.12.
7. Avg.Gls: average goals per game for this fixture context (e.g. 2.3).
8. Return RAW CSV ONLY. No markdown, no explanation, no intro.`;

const P1_SYS = `You are a football statistics analysis engine. Today is ${TODAY}.

INPUT per match: all CSV stats + conflict flags already detected.

SCORING RULES — follow exactly:
1. BEST BET = pick with highest value_score = (conf/100) × ln(odds). This rewards value, penalises short prices. 99% at 1.04 = 0.039. 72% at 1.85 = 0.44. NEVER choose DC/1.04 when better options exist.
2. EDGE BET = pick where edge = conf% minus (1/odds × 100) AND edge >= 8% AND real odds must exist. If none qualify: edgeBet null.
3. ACCA PICK = highest confidence market >= 60% on this match. This is NOT the same as Best Bet. It is the pick most likely to WIN regardless of odds.
4. CONFLICTS in input: apply them — BTTS_TRAP = reduce btts conf -15, OVER_TRAP = reduce ou25 conf -10, XG_SURGE = boost over confs +5, LOW_SCORING = boost under confs +5.
5. Keep ALL text fields under 10 words.

RESPOND ONLY WITH RAW JSON ARRAY. [ at start, ] at end, nothing else.

One object per match:
{"match":"Arsenal vs Chelsea","flags":["BTTS TRAP"],"signal":7,"markets":{"result":{"pick":"1","conf":72,"odds":"1.85","source":"book"},"doubleChance":{"pick":"1X","conf":88,"odds":"1.14","source":"impl"},"drawNoBet":{"pick":"Home","conf":72,"odds":"1.85","source":"impl"},"btts":{"pick":"GG","conf":52,"odds":"1.92","source":"book"},"ou15":{"pick":"O1.5","conf":90,"odds":"1.25","source":"book"},"ou25":{"pick":"O2.5","conf":64,"odds":"1.95","source":"book"},"ou35":{"pick":"U3.5","conf":68,"odds":"1.47","source":"impl"},"asianHandicap":{"pick":"Home -0.5","conf":58,"odds":"1.82","source":"impl"},"totalGoalsRange":{"pick":"2-3","conf":48,"odds":"2.08","source":"impl"},"winToNil":{"pick":"Home WTN","conf":42,"odds":"2.38","source":"impl"},"htResult":{"pick":"1","conf":55,"odds":"1.80","source":"impl"}},"bestBet":{"pick":"Home Win","market":"Result","conf":72,"odds":"1.85","source":"book","score":0.44,"why":"Strong form gap, away winless 4"},"edgeBet":{"pick":"GG Yes","market":"BTTS","conf":65,"odds":"1.72","source":"book","edge":7,"why":"Model 65% vs book 58%"},"accaPick":{"pick":"O1.5","market":"O/U 1.5","conf":90,"odds":"1.25","source":"book"},"realOdds":{"h":"1.85","x":"3.40","a":"4.20","over25":"1.95","under25":"1.85","ggYes":"1.72","ggNo":"2.05","o15":"1.25","u15":"3.80"}}`;

const P2_SYS = `You are a football deep analysis engine. Today is ${TODAY}.

Same scoring rules as pass 1: Best Bet = conf × ln(odds), Edge Bet = edge>=8% real odds only, Acca Pick = highest conf >= 60%.
Include full stats, H2H, conflicts. Keep text under 12 words each.
RESPOND ONLY WITH RAW JSON ARRAY.

{"match":"Arsenal vs Chelsea","league":"Premier League","conflicts":["BTTS TRAP: H.CS 40%, A.FTS 28%"],"realOdds":{"h":"1.85","x":"3.40","a":"4.20","over25":"1.95","under25":"1.85","ggYes":"1.72","ggNo":"2.05","o15":"1.25","u15":"3.80"},"markets":{"result":{"pick":"1","conf":72,"odds":"1.85","source":"book"},"doubleChance":{"pick":"1X","conf":88,"odds":"1.14","source":"impl"},"drawNoBet":{"pick":"Home","conf":72,"odds":"1.85","source":"impl"},"btts":{"pick":"GG","conf":52,"odds":"1.92","source":"book"},"ou15":{"pick":"O1.5","conf":90,"odds":"1.25","source":"book"},"ou25":{"pick":"O2.5","conf":64,"odds":"1.95","source":"book"},"ou35":{"pick":"U3.5","conf":68,"odds":"1.47","source":"impl"},"asianHandicap":{"pick":"Home -0.5","conf":58,"odds":"1.82","source":"impl"},"totalGoalsRange":{"pick":"2-3","conf":48,"odds":"2.08","source":"impl"},"winToNil":{"pick":"Home WTN","conf":42,"odds":"2.38","source":"impl"},"htResult":{"pick":"1","conf":55,"odds":"1.80","source":"impl"}},"bestBet":{"pick":"Home Win","market":"Result","conf":72,"odds":"1.85","source":"book","score":0.44,"why":"Form gap, home fortress last 6"},"edgeBet":{"pick":"O2.5","market":"Over 2.5","conf":64,"odds":"1.95","source":"book","edge":13,"why":"Model 64% vs book 51%"},"accaPick":{"pick":"O1.5","market":"O/U 1.5","conf":90,"odds":"1.25","source":"book"},"stats":{"home":{"team":"Arsenal","last5All":"W W D L W","gfGaAll":"9/5","last5Home":"W W W D L","gfGaHome":"6/2","cleanSheets":"2/5","avgGoals":"2.4/g","injuries":"None"},"away":{"team":"Chelsea","last5All":"L W D W L","gfGaAll":"6/7","last5Away":"L D W L D","gfGaAway":"3/5","cleanSheets":"1/5","avgGoals":"1.4/g","injuries":"2 mid out"},"h2h":{"record":"3W-1D-1L","avgGoals":"2.8/g","bttsRate":"60%","over25Rate":"60%"}},"reasoning":"Home dominates. Over 2.5 underpriced."}`;

// ─────────────────────────────────────────────────────────────────────────────
// MATCH CARD (PASS 1)
// ─────────────────────────────────────────────────────────────────────────────
function MatchCard({ data, onDeep, deepLoading, deepDone }) {
  const { match, flags, markets, bestBet, edgeBet, accaPick, realOdds, signal } = data;
  const primary = [
    { key: "result", lbl: "Result" }, { key: "btts", lbl: "BTTS" },
    { key: "ou25", lbl: "O/U 2.5" }, { key: "ou15", lbl: "O/U 1.5" },
    { key: "doubleChance", lbl: "DC" }, { key: "htResult", lbl: "HT" },
  ].map(m => ({ ...m, ...(markets?.[m.key] || {}) })).filter(m => m.pick);

  const scoreNorm = Math.min((bestBet?.score || 0) / 0.8, 1);

  return (
    <div className={`card ${deepDone ? "deep" : ""}`}>
      <div className="card-head">
        <div>
          <div className="card-match">{match}</div>
          <div className="card-meta">
            <div className="sig-dot" style={{ background: sigColor(signal || 0) }} />
            <span className="sig-lbl">Signal {signal || "?"}/10</span>
            {(flags || []).map(f => <span key={f} className={`tg ${f.includes("TRAP") ? "tg-r" : f.includes("SURGE") || f.includes("VALUE") ? "tg-a" : "tg-p"}`}>{f}</span>)}
            {deepDone && <span className="tg tg-b">🔍</span>}
          </div>
        </div>
      </div>
      <div className="card-body">
        {bestBet && (
          <div className="best-box">
            <div className="best-lbl">★ Best Bet — Value Pick</div>
            <div className="best-pick">{bestBet.market}: {bestBet.pick}</div>
            <div className="best-meta">{bestBet.conf}% conf · {bestBet.odds} {bestBet.source === "book" ? "📊" : ""}</div>
            <div className="best-why">{bestBet.why}</div>
            <div className="best-score-row">
              <span className="best-score-lbl">VALUE SCORE</span>
              <span className="best-score-val">{(bestBet.score || 0).toFixed(3)}</span>
              <div className="best-score-track"><div className="best-score-fill" style={{ width: `${scoreNorm * 100}%` }} /></div>
            </div>
          </div>
        )}
        {edgeBet ? (
          <div className="edge-box">
            <div className="edge-lbl">◆ Edge Bet — Market Mismatch</div>
            <div className="edge-pick-big">{edgeBet.market}: {edgeBet.pick}</div>
            <div className="edge-meta">{edgeBet.conf}% conf · {edgeBet.odds} 📊</div>
            <div className="edge-pct-row">+{edgeBet.edge}% edge vs bookmaker</div>
            <div className="edge-why-txt">{edgeBet.why}</div>
          </div>
        ) : (
          <div className="no-edge-box">
            <div className="no-edge-lbl">◆ Edge Bet</div>
            <div className="no-edge-txt">No qualifying edge ≥8% with real odds</div>
          </div>
        )}
        {accaPick && (
          <div style={{ background: "#0a0f18", border: "1px solid rgba(61,158,255,.2)", borderRadius: 6, padding: "8px 11px", marginBottom: 8 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 7, letterSpacing: "2.5px", textTransform: "uppercase", color: "var(--b)", marginBottom: 3 }}>🎰 Acca Pick — Highest Confidence</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--b)", lineHeight: 1 }}>{accaPick.market}: {accaPick.pick}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#2a5a7a", marginTop: 2 }}>{accaPick.conf}% conf · {accaPick.odds} {accaPick.source === "book" ? "📊" : ""}</div>
          </div>
        )}
        <div className="mkts-grid">
          {primary.map(m => (
            <div key={m.key} className={`mkt ${m.conf >= 70 ? "hot" : ""} ${m.source === "book" ? "book" : ""}`}>
              <div className="mkt-l">{m.lbl}</div>
              <div className="mkt-v" style={{ color: gc(m.conf) }}>{m.pick}</div>
              <div className="mkt-c" style={{ color: gc(m.conf) }}>{m.conf}%</div>
              <div className="mkt-o">{m.odds}</div>
              {m.source === "book" && <div className="mkt-src">📊</div>}
            </div>
          ))}
        </div>
        {realOdds && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {[["1", realOdds.h], ["X", realOdds.x], ["2", realOdds.a], ["O2.5", realOdds.over25], ["GG", realOdds.ggYes]].filter(([, v]) => v && parseFloat(v) > 1).map(([l, v]) => (
              <div key={l} style={{ background: "#070f14", border: "1px solid var(--bd)", borderRadius: 3, padding: "2px 6px", fontFamily: "var(--mono)", fontSize: 9 }}>
                {l} <span style={{ color: "var(--a)", fontWeight: 700 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        <div className="card-foot">
          <div className="card-foot-note">📊 = real odds · no mark = implied</div>
          <button className={`deep-btn ${deepDone ? "done" : ""}`} onClick={() => onDeep(data)} disabled={deepLoading || deepDone}>
            {deepDone ? "✓ Deep" : deepLoading ? "..." : "🔍 Deep"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DEEP CARD (PASS 2)
// ─────────────────────────────────────────────────────────────────────────────
function DeepCard({ data }) {
  const { match, league, conflicts, realOdds, markets, bestBet, edgeBet, accaPick, stats, reasoning } = data;
  const primary = ["result", "btts", "ou25"].map(k => ({ key: k, lbl: mktLabel(k), ...(markets?.[k] || {}) })).filter(m => m.pick);
  const secondary = ["doubleChance", "drawNoBet", "ou15", "ou35", "asianHandicap", "totalGoalsRange", "winToNil", "htResult"].filter(k => markets?.[k]?.pick).map(k => ({ key: k, lbl: mktLabel(k), ...markets[k] }));
  const scoreNorm = Math.min((bestBet?.score || 0) / 0.8, 1);

  return (
    <div className="card deep">
      <div className="card-head">
        <div>
          <div className="card-match">{match}</div>
          <div className="card-meta">
            <span className="card-league">{league || "Football"}</span>
            <span className="tg tg-b">🔍 DEEP</span>
            {conflicts?.length > 0 && <span className="tg tg-a">⚠ {conflicts.length} CONFLICT{conflicts.length > 1 ? "S" : ""}</span>}
          </div>
        </div>
      </div>
      <div className="card-body">
        {bestBet && (
          <div className="best-box">
            <div className="best-lbl">★ Best Bet — Value Pick</div>
            <div className="best-pick">{bestBet.market}: {bestBet.pick}</div>
            <div className="best-meta">{bestBet.conf}% conf · {bestBet.odds} {bestBet.source === "book" ? "📊" : ""}</div>
            <div className="best-why">{bestBet.why}</div>
            <div className="best-score-row">
              <span className="best-score-lbl">VALUE SCORE</span>
              <span className="best-score-val">{(bestBet.score || 0).toFixed(3)}</span>
              <div className="best-score-track"><div className="best-score-fill" style={{ width: `${scoreNorm * 100}%` }} /></div>
            </div>
          </div>
        )}
        {edgeBet ? (
          <div className="edge-box">
            <div className="edge-lbl">◆ Edge Bet — Market Mismatch</div>
            <div className="edge-pick-big">{edgeBet.market}: {edgeBet.pick}</div>
            <div className="edge-meta">{edgeBet.conf}% conf · {edgeBet.odds} 📊</div>
            <div className="edge-pct-row">+{edgeBet.edge}% edge vs bookmaker</div>
            <div className="edge-why-txt">{edgeBet.why}</div>
          </div>
        ) : (
          <div className="no-edge-box">
            <div className="no-edge-lbl">◆ Edge Bet</div>
            <div className="no-edge-txt">No qualifying edge ≥8% with real odds</div>
          </div>
        )}
        {accaPick && (
          <div style={{ background: "#0a0f18", border: "1px solid rgba(61,158,255,.2)", borderRadius: 6, padding: "8px 11px", marginBottom: 8 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 7, letterSpacing: "2.5px", textTransform: "uppercase", color: "var(--b)", marginBottom: 3 }}>🎰 Acca Pick — Highest Confidence</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--b)", lineHeight: 1 }}>{accaPick.market}: {accaPick.pick}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#2a5a7a", marginTop: 2 }}>{accaPick.conf}% conf · {accaPick.odds} {accaPick.source === "book" ? "📊" : ""}</div>
          </div>
        )}
        {conflicts?.length > 0 && (
          <div className="conflict-box">
            <div className="conflict-lbl">⚠ Conflicts Detected</div>
            {conflicts.map((c, i) => <div key={i} className="conflict-item">· {typeof c === "string" ? c : c.desc || c}</div>)}
          </div>
        )}
        {realOdds && (
          <div className="odds-panel">
            <div className="odds-panel-t">📊 Bookmaker Odds</div>
            <div className="odds-grid">
              {[["Home", realOdds.h], ["Draw", realOdds.x], ["Away", realOdds.a], ["Over 2.5", realOdds.over25], ["Under 2.5", realOdds.under25], ["GG Yes", realOdds.ggYes], ["GG No", realOdds.ggNo], ["O1.5", realOdds.o15], ["U1.5", realOdds.u15]].filter(([, v]) => v && parseFloat(v) > 1).map(([l, v]) => (
                <div key={l} className="oc"><div className="oc-l">{l}</div><div className="oc-v">{v}</div><div className="oc-i">{oddsToImpl(parseFloat(v))}%</div></div>
              ))}
            </div>
          </div>
        )}
        <div className="bars">{primary.map(m => <ConfBar key={m.key} label={`${m.lbl} · ${m.pick}`} pct={m.conf} color={gc(m.conf)} />)}</div>
        {secondary.length > 0 && (
          <div className="om-grid">
            {secondary.map(m => (
              <div key={m.key} className={`om ${m.conf >= 65 ? "hot" : ""}`}>
                <span className="om-l">{m.lbl}</span>
                <div className="om-r">
                  <span className="om-v" style={{ color: gc(m.conf) }}>{m.pick}</span>
                  <span className="om-c">{m.conf}%</span>
                  <span className="om-o">{m.odds}{m.source === "book" ? " 📊" : ""}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {stats && (
          <div className="stats-sec">
            <div className="stats-sec-l">Team Stats</div>
            <div className="stats-grid">
              {stats.home && (
                <div className="stat-box">
                  <div className="stat-box-t">🏠 {stats.home.team}</div>
                  {[["Last 5 all", stats.home.last5All], ["GF/GA all", stats.home.gfGaAll], ["Last 5 home", stats.home.last5Home], ["GF/GA home", stats.home.gfGaHome], ["Clean sheets", stats.home.cleanSheets], ["Avg goals", stats.home.avgGoals], ["Injuries", stats.home.injuries]].filter(([, v]) => v && v !== "None").map(([k, v]) => (
                    <div key={k} className="stat-row"><span className="stat-k">{k}</span><span className="stat-v">{v}</span></div>
                  ))}
                </div>
              )}
              {stats.away && (
                <div className="stat-box">
                  <div className="stat-box-t">✈️ {stats.away.team}</div>
                  {[["Last 5 all", stats.away.last5All], ["GF/GA all", stats.away.gfGaAll], ["Last 5 away", stats.away.last5Away], ["GF/GA away", stats.away.gfGaAway], ["Clean sheets", stats.away.cleanSheets], ["Avg goals", stats.away.avgGoals], ["Injuries", stats.away.injuries]].filter(([, v]) => v && v !== "None").map(([k, v]) => (
                    <div key={k} className="stat-row"><span className="stat-k">{k}</span><span className="stat-v">{v}</span></div>
                  ))}
                </div>
              )}
              {stats.h2h && (
                <div className="stat-box h2h-full">
                  <div className="stat-box-t">⚔️ H2H (last 5)</div>
                  {[["Record", stats.h2h.record], ["Avg goals", stats.h2h.avgGoals], ["BTTS rate", stats.h2h.bttsRate], ["Over 2.5", stats.h2h.over25Rate]].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="stat-row"><span className="stat-k">{k}</span><span className="stat-v">{v}</span></div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {reasoning && <div className="stats-sec"><div className="stats-sec-l">Reasoning</div><div className="rsn">{reasoning}</div></div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORTLIST + EDGE BOARD
// ─────────────────────────────────────────────────────────────────────────────
function DailyShortlist({ results, onScrollTo }) {
  const sorted = [...results].filter(r => r.bestBet?.score > 0).sort((a, b) => (b.bestBet?.score || 0) - (a.bestBet?.score || 0)).slice(0, 5);
  if (!sorted.length) return null;
  return (
    <div className="shortlist">
      <div className="shortlist-t">★ Daily Shortlist</div>
      <div className="shortlist-s">Top {sorted.length} value picks · conf × ln(odds)</div>
      {sorted.map((r, i) => (
        <div key={i} className="sl-row" onClick={() => onScrollTo(r.match)}>
          <div className="sl-rank">#{i + 1}</div>
          <div className="sl-body">
            <div className="sl-match">{r.match}</div>
            <div className="sl-pick">{r.bestBet.market}: {r.bestBet.pick} · {r.bestBet.conf}% conf</div>
            <div className="sl-bar"><div className="sl-fill" style={{ width: `${Math.min((r.bestBet.score / 0.8) * 100, 100)}%`, background: "var(--g)" }} /></div>
          </div>
          <div className="sl-right">
            <div className="sl-num" style={{ color: "var(--g)" }}>{r.bestBet.score?.toFixed(3)}</div>
            <div className="sl-odds">{r.bestBet.odds}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EdgeBoard({ results, onScrollTo }) {
  const edges = [...results].filter(r => r.edgeBet?.edge >= 8).sort((a, b) => (b.edgeBet?.edge || 0) - (a.edgeBet?.edge || 0)).slice(0, 5);
  return (
    <div className="edgeboard">
      <div className="edgeboard-t">◆ Edge Radar</div>
      <div className="edgeboard-s">Bookmaker mispricing ≥8% · real odds only</div>
      {edges.length === 0 ? <div className="no-board-msg">No qualifying edges yet.</div> : edges.map((r, i) => (
        <div key={i} className="edge-row" onClick={() => onScrollTo(r.match)}>
          <div className="edge-rank">#{i + 1}</div>
          <div className="edge-body">
            <div className="edge-match">{r.match}</div>
            <div className="edge-pick">{r.edgeBet.market}: {r.edgeBet.pick}</div>
            <div className="edge-bar"><div className="edge-fill" style={{ width: `${Math.min(r.edgeBet.edge * 3, 100)}%` }} /></div>
          </div>
          <div className="edge-right">
            <div className="edge-pct">+{r.edgeBet.edge}%</div>
            <div className="edge-odds">{r.edgeBet.odds}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCA PANEL — THREE TABS
// ─────────────────────────────────────────────────────────────────────────────
function AccaPanel({ results }) {
  const [accaTab, setAccaTab] = useState("conf");
  const [legs, setLegs] = useState(5);
  const [stake, setStake] = useState("");

  // BEST CONF: sorted by confidence desc, conf >= 60, uses accaPick field
  const confPool = results
    .filter(r => {
      const pick = r.accaPick || getAccaPick(r);
      return pick && pick.conf >= CONF_FLOOR && parseFloat(pick.odds) > 1.05;
    })
    .map(r => {
      const pick = r.accaPick || getAccaPick(r);
      return { match: r.match, ...pick, sortKey: pick.conf };
    })
    .sort((a, b) => b.sortKey - a.sortKey);

  // BEST VALUE: sorted by value score desc, uses bestBet field
  const valuePool = results
    .filter(r => r.bestBet?.score > 0 && parseFloat(r.bestBet?.odds) > 1.10)
    .map(r => ({ match: r.match, ...r.bestBet, sortKey: r.bestBet.score }))
    .sort((a, b) => b.sortKey - a.sortKey);

  // CRAZY PARLAY: EV > 0 AND conf >= 45, uses crazyPick (value score sorted)
  const crazyPool = results
    .filter(r => {
      const pick = r.bestBet || getCrazyPick(r);
      if (!pick) return false;
      const o = parseFloat(pick.odds);
      if (!o || o <= 1.20) return false;
      const ev = calcEV(pick.conf, pick.odds);
      return ev !== null && ev > 0 && pick.conf >= CRAZY_CONF_FLOOR;
    })
    .map(r => {
      const pick = r.bestBet || getCrazyPick(r);
      const ev = calcEV(pick.conf, pick.odds);
      return { match: r.match, ...pick, ev, sortKey: pick.score || valueScore(pick.conf, pick.odds) };
    })
    .sort((a, b) => b.sortKey - a.sortKey);

  const pools = { conf: confPool, value: valuePool, crazy: crazyPool };
  const pool = pools[accaTab] || [];
  const maxLegs = Math.max(2, pool.length);
  const actualLegs = Math.min(legs, pool.length);
  const picked = pool.slice(0, actualLegs);

  // Kick-out: negative edge on real odds (value/crazy only)
  const kicked = accaTab !== "conf" ? picked.filter(r => {
    if (r.source !== "book") return false;
    const edge = calcEdge(r.conf, r.odds);
    return edge !== null && edge < 0;
  }) : [];
  const clean = picked.filter(r => !kicked.includes(r));
  const combined = clean.reduce((acc, r) => acc * (parseFloat(r.odds) || 1), 1);
  const s = parseFloat(stake);
  const gross = s && combined > 1 ? (s * combined).toFixed(2) : null;
  const profit = gross ? (parseFloat(gross) - s).toFixed(2) : null;

  const tabDefs = [
    { id: "conf", icon: "🛡", label: "Best Conf" },
    { id: "value", icon: "💎", label: "Best Value" },
    { id: "crazy", icon: "🔥", label: "Parlay" },
  ];

  const infos = {
    conf: `🛡 Picks ranked by highest confidence ≥${CONF_FLOOR}%. These are the legs the model believes will WIN. Safe builder. Uses Acca Pick (not Best Bet).`,
    value: `💎 Picks ranked by value score (conf × ln(odds)). Rewards real pricing edge. Best Bet from each match. May include risky picks with high odds.`,
    crazy: `🔥 Picks where EV > 0 AND conf ≥${CRAZY_CONF_FLOOR}%. High risk, high reward. Includes picks the model believes are mispriced but not necessarily safe.`,
  };

  const pickColors = { conf: "var(--b)", value: "var(--g)", crazy: "var(--r)" };
  const pickColor = pickColors[accaTab];

  if (!results.length) return <div className="screen"><div className="no-acca">Run Pass 1 first to build your accumulator.</div></div>;

  return (
    <div className="screen">
      <div className="acca-tabs">
        {tabDefs.map(t => (
          <button key={t.id} className={`acca-tab ${accaTab === t.id ? "on" : ""}`} onClick={() => setAccaTab(t.id)}>
            <span className="acca-tab-i">{t.icon}</span>
            <span className="acca-tab-l">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="acca-wrap">
        <div className="acca-info">{infos[accaTab]}</div>
        {pool.length === 0 ? (
          <div className="no-acca">No qualifying picks for this acca type.<br />Run more matches or lower the confidence floor.</div>
        ) : (
          <>
            <div className="slider-row">
              <span className="slider-lbl">Legs: <em style={{ color: pickColor }}>{actualLegs}</em></span>
              <input type="range" min={2} max={maxLegs} value={Math.min(legs, maxLegs)} onChange={e => setLegs(parseInt(e.target.value))} />
              <span className="slider-max">{pool.length} avail</span>
            </div>
            {kicked.length > 0 && (
              <div className="acca-kick">
                <em>⚠ {kicked.length} kick-out{kicked.length > 1 ? "s" : ""}:</em> {kicked.map(r => r.match.split(" vs ")[0]).join(", ")} — negative edge on real odds
              </div>
            )}
            {clean.length === 0 ? (
              <div className="no-acca">All picks removed by kick-out rule. Increase legs.</div>
            ) : (
              <>
                {clean.map((r, i) => (
                  <div key={i} className="acca-leg">
                    <div className="al-num" style={{ color: pickColor }}>#{i + 1}</div>
                    <div className="al-body">
                      <div className="al-match">{r.match}</div>
                      <div className="al-pick" style={{ color: pickColor }}>{r.market}: {r.pick}</div>
                      <div className="al-conf">
                        {r.conf}% conf
                        {accaTab === "value" && r.score ? ` · score ${r.score.toFixed(3)}` : ""}
                        {accaTab === "crazy" && r.ev !== undefined ? ` · EV ${r.ev > 0 ? "+" : ""}${r.ev}` : ""}
                        {r.source === "book" ? " · 📊" : ""}
                      </div>
                    </div>
                    <div className="al-odds" style={{ color: "var(--a)" }}>{parseFloat(r.odds).toFixed(2)}</div>
                  </div>
                ))}
                <hr className="acca-hr" />
                <div className="acca-totals">
                  <div className="acca-stat"><div className="al">Legs</div><div className="av" style={{ color: pickColor }}>{clean.length}</div></div>
                  <div className="acca-stat"><div className="al">Combined</div><div className="av" style={{ color: "var(--g)" }}>{combined.toFixed(2)}</div></div>
                </div>
                <div className="stake-row">
                  <span className="stake-lbl">Stake (₦)</span>
                  <input className="stake-input" type="number" min="0" placeholder="1000" value={stake} onChange={e => setStake(e.target.value)} />
                  {gross && (
                    <div className="ret-wrap">
                      <div className="ri"><div className="rl">Return</div><div className="rv" style={{ color: "var(--a)" }}>₦{parseFloat(gross).toLocaleString()}</div></div>
                      <div className="ri"><div className="rl">Profit</div><div className="rv" style={{ color: "var(--g)" }}>₦{parseFloat(profit).toLocaleString()}</div></div>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACKER
// ─────────────────────────────────────────────────────────────────────────────
function TrackerPanel({ results }) {
  const [tracked, setTracked] = useState(() => LS.get("fs_tracked", []));
  const [checking, setChecking] = useState(new Set());

  useEffect(() => {
    if (!results.length) return;
    setTracked(prev => {
      const existing = new Set(prev.map(t => t.id));
      const newEntries = results.filter(r => r.bestBet && !existing.has(r.match)).map(r => ({
        id: r.match, match: r.match, pick: r.bestBet.pick, market: r.bestBet.market,
        odds: r.bestBet.odds, conf: r.bestBet.conf, date: TODAY, result: null, scoreStr: null,
      }));
      if (!newEntries.length) return prev;
      const updated = [...prev, ...newEntries];
      LS.set("fs_tracked", updated);
      return updated;
    });
  }, [results.length]);

  function mark(id, result) {
    setTracked(prev => { const u = prev.map(t => t.id === id ? { ...t, result } : t); LS.set("fs_tracked", u); return u; });
  }

  async function autoCheck(entry) {
    setChecking(prev => new Set([...prev, entry.id]));
    try {
      const res = await checkResultOnline(entry.match, entry.date);
      if (res?.status === "final" && res.homeScore !== undefined) {
        const scoreStr = `${res.homeScore}-${res.awayScore}`;
        setTracked(prev => { const u = prev.map(t => t.id === entry.id ? { ...t, scoreStr } : t); LS.set("fs_tracked", u); return u; });
      }
    } catch {}
    setChecking(prev => { const n = new Set(prev); n.delete(entry.id); return n; });
  }

  const wins = tracked.filter(t => t.result === "W").length;
  const losses = tracked.filter(t => t.result === "L").length;
  const pushes = tracked.filter(t => t.result === "P").length;
  const settled = wins + losses + pushes;
  const hitRate = settled > 0 ? Math.round((wins / settled) * 100) : null;

  return (
    <div className="screen">
      <div className="tracker-stats">
        <div className="ts"><div className="ts-l">Tracked</div><div className="ts-v" style={{ color: "var(--b)" }}>{tracked.length}</div></div>
        <div className="ts"><div className="ts-l">Wins</div><div className="ts-v" style={{ color: "var(--g)" }}>{wins}</div></div>
        <div className="ts"><div className="ts-l">Losses</div><div className="ts-v" style={{ color: "var(--r)" }}>{losses}</div></div>
        <div className="ts">
          <div className="ts-l">Hit Rate</div>
          <div className="ts-v" style={{ color: hitRate === null ? "var(--mu)" : hitRate >= 55 ? "var(--g)" : hitRate >= 40 ? "var(--a)" : "var(--r)" }}>
            {hitRate !== null ? `${hitRate}%` : "—"}
          </div>
          <div className="ts-s">{settled} settled</div>
        </div>
      </div>
      {tracked.length === 0 ? (
        <div className="no-tracker">Best bets auto-populate after Pass 1.<br />Mark W / L / P after each match.<br />🔍 Check fetches final scores via web search.</div>
      ) : (
        <>
          {[...tracked].reverse().map(t => (
            <div key={t.id} className="tracker-row">
              <div className="tr-match">
                <div className="tr-name">{t.match}</div>
                <div className="tr-pick">{t.market}: {t.pick}</div>
                <div className="tr-date">{t.date}{t.scoreStr ? ` · ${t.scoreStr}` : ""}</div>
              </div>
              <div className="tr-odds">{t.odds}</div>
              {t.result ? (
                <div className={`tr-result tr-result-${t.result.toLowerCase()}`}>{t.result === "W" ? "✓ WIN" : t.result === "L" ? "✗ LOSS" : "~ PUSH"}</div>
              ) : (
                <div className="tr-btns">
                  <button className="tr-btn tr-btn-w" onClick={() => mark(t.id, "W")}>W</button>
                  <button className="tr-btn tr-btn-l" onClick={() => mark(t.id, "L")}>L</button>
                  <button className="tr-btn tr-btn-p" onClick={() => mark(t.id, "P")}>P</button>
                  {checking.has(t.id)
                    ? <span className="tr-checking">checking…</span>
                    : <button className="tr-check-btn" onClick={() => autoCheck(t)}>🔍 Check</button>}
                </div>
              )}
            </div>
          ))}
          <div style={{ marginTop: 11 }}>
            <button className="btn btn-r btn-sm" onClick={() => { setTracked([]); LS.set("fs_tracked", []); }}>🗑 Clear Tracker</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function SettingsScreen({ onClear }) {
  return (
    <div className="screen">
      <div className="s-wrap">
        <div className="s-blk">
          <div className="s-blk-t">Gemini Prompt</div>
          <p className="s-text">Copy and send to Gemini with your fixtures source:</p>
          <div className="prompt-box">{GEMINI_PROMPT}</div>
          <button className="btn btn-o btn-sm" onClick={() => navigator.clipboard?.writeText(GEMINI_PROMPT)}>📋 Copy Prompt</button>
        </div>
        <div className="s-blk">
          <div className="s-blk-t">Scoring Model</div>
          <div className="s-text">
            <em>Best Bet</em> = conf × ln(odds). Value scoring. 72% at 1.85 = 0.44. DC at 1.04 never wins.<br /><br />
            <em>Edge Bet</em> = edge ≥8% with REAL odds only. Never implied.<br /><br />
            <em>Acca Pick</em> = highest-confidence market ≥{CONF_FLOOR}%. Separate from Best Bet. Used in Best Conf acca.<br /><br />
            <em>Conflict detectors</em> run on raw CSV before the API: BTTS TRAP reduces BTTS conf, OVER TRAP reduces Over conf, xG SURGE boosts overs, FORM GAP flags PPG mismatches, LOW SCORING boosts unders.<br /><br />
            <em>Pre-EV</em> = EV for O2.5 and BTTS calculated from CSV before Pass 1. BET = EV &gt; 0.05 · MAYBE = EV 0–0.05 · SKIP = EV &lt; 0.
          </div>
        </div>
        <div className="s-blk">
          <div className="s-blk-t">Three Acca Types</div>
          <div className="s-text">
            <em>🛡 Best Conf</em> — ranked by confidence ≥{CONF_FLOOR}%. Safe builder. Uses Acca Pick per match.<br /><br />
            <em>💎 Best Value</em> — ranked by value score (conf × ln(odds)). Rewards mispriced markets.<br /><br />
            <em>🔥 Crazy Parlay</em> — EV &gt; 0 AND conf ≥{CRAZY_CONF_FLOOR}%. High risk, high odds. Goes after draws and long shots.
          </div>
        </div>
        <div className="s-blk">
          <div className="s-blk-t">Workflow</div>
          <div className="s-text">
            1. Get CSV from Gemini using the prompt above<br />
            2. Paste CSV → Save & Load → select matches<br />
            3. ⚡ Pass 1 → quick scan, {BATCH_SIZE} per batch<br />
            4. 🔍 Deep → deep dive on key matches<br />
            5. Results tab → Shortlist + Edge Radar<br />
            6. Acca tab → pick your type + adjust legs<br />
            7. Tracker → mark results → build hit rate
          </div>
        </div>
        <div className="s-blk">
          <div className="s-blk-t">Data</div>
          <p className="s-text">All data stored locally. CSV hash invalidates cache on change. Tracker persists independently.</p>
          <button className="btn btn-r btn-sm" onClick={onClear}>🗑 Clear All</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("home");
  const [csvText, setCsvText] = useState("");
  const [matches, setMatches] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [p1Results, setP1Results] = useState([]);
  const [p2Results, setP2Results] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deepLoading, setDeepLoading] = useState(new Set());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [csvSaved, setCsvSaved] = useState(false);
  const [batchProg, setBatchProg] = useState(null);
  const abortRef = useRef(false);

  const allResults = [
    ...p2Results,
    ...p1Results.filter(r => !p2Results.find(p => p.match === r.match)),
  ];

  useEffect(() => {
    const saved = LS.raw("fs_csv");
    if (saved) { setCsvText(saved); setCsvSaved(true); setMatches(parseCSV(saved)); }
    const hash = saved ? csvHash(saved) : null;
    if (hash && hash === LS.raw("fs_csv_hash")) {
      const r1 = LS.get("fs_p1"); const r2 = LS.get("fs_p2");
      if (r1?.length) setP1Results(r1);
      if (r2?.length) setP2Results(r2);
    }
  }, []);

  function handleCSV(val) {
    setCsvText(val); setCsvSaved(false);
    setMatches(parseCSV(val));
    setP1Results([]); setP2Results([]);
  }

  function saveCSV() {
    LS.rawSet("fs_csv", csvText);
    LS.rawSet("fs_csv_hash", csvHash(csvText));
    setCsvSaved(true);
    const m = parseCSV(csvText); setMatches(m);
    setStatus(`✓ ${m.length} matches loaded`);
    setTimeout(() => setStatus(""), 2500);
  }

  function clearAll() {
    ["fs_csv", "fs_csv_hash"].forEach(k => LS.rawSet(k, ""));
    ["fs_p1", "fs_p2"].forEach(k => LS.set(k, null));
    setCsvText(""); setCsvSaved(false); setMatches([]);
    setP1Results([]); setP2Results([]); setSelected(new Set());
    setStatus("Cleared"); setTimeout(() => setStatus(""), 1500);
  }

  const toggleMatch = id => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelected(new Set(matches.map(m => m.id)));
  const deselectAll = () => setSelected(new Set());

  async function runPass1() {
    const picks = matches.filter(m => selected.has(m.id));
    if (!picks.length) return;
    abortRef.current = false; setLoading(true); setError(""); setP1Results([]); setP2Results([]);
    const batches = [];
    for (let i = 0; i < picks.length; i += BATCH_SIZE) batches.push(picks.slice(i, i + BATCH_SIZE));
    let all = [];
    for (let bi = 0; bi < batches.length; bi++) {
      if (abortRef.current) { setStatus(`Stopped · ${all.length} done`); break; }
      const batch = batches[bi];
      setBatchProg({ cur: bi + 1, total: batches.length, done: all.length, totalM: picks.length });
      setStatus(`⚡ Pass 1 · Batch ${bi + 1}/${batches.length}...`);
      const lines = batch.map(m => {
        const cf = m.conflicts.map(c => c.key).join(",") || "NONE";
        return `${m.home} vs ${m.away} | PPG.H:${m.ppgHome} | PPG.A:${m.ppgAway} | O2.5%:${m.ou25} | O1.5%:${m.ou15} | O3.5%:${m.ou35} | BTTS%:${m.btts} | H.CS%:${m.hcs} | A.CS%:${m.acs} | H.FTS%:${m.hfts} | A.FTS%:${m.afts} | xG.Delta:${m.xgDelta} | AvgGls:${m.avgGoals} | Odds.1:${m.odds1} | Odds.X:${m.oddsX} | Odds.2:${m.odds2} | Odds.Over2.5:${m.oddsOver25} | Odds.Under2.5:${m.oddsUnder25} | Odds.GG_Yes:${m.oddsGGYes} | Odds.GG_No:${m.oddsGGNo} | Odds.O1.5:${m.oddsO15} | Odds.U1.5:${m.oddsU15} | CONFLICTS:${cf}`;
      }).join("\n");
      try {
        const parsed = await callClaude(P1_SYS, `Today ${TODAY}. Analyze ${batch.length} matches:\n${lines}`, 8000);
        if (Array.isArray(parsed) && parsed.length > 0) {
          all = [...all, ...parsed];
          setP1Results([...all]);
          LS.set("fs_p1", all);
          LS.rawSet("fs_csv_hash", csvHash(csvText));
          if (bi === 0) setTab("results");
        }
      } catch (e) { setError(`Batch ${bi + 1} failed: ${e.message}`); }
      if (bi < batches.length - 1 && !abortRef.current) await new Promise(r => setTimeout(r, 800));
    }
    setLoading(false); setBatchProg(null);
    setStatus(`✓ Pass 1 done · ${all.length} matches`);
    setTimeout(() => setStatus(""), 3000);
  }

  async function runPass2(p1data) {
    const key = p1data.match;
    const csvMatch = matches.find(m => `${m.home} vs ${m.away}` === key || key.startsWith(m.home));
    setDeepLoading(p => new Set([...p, key])); setError("");
    try {
      const cf = csvMatch?.conflicts?.map(c => c.key).join(",") || "NONE";
      const line = csvMatch
        ? `${csvMatch.home} vs ${csvMatch.away} | PPG.H:${csvMatch.ppgHome} | PPG.A:${csvMatch.ppgAway} | O2.5%:${csvMatch.ou25} | O1.5%:${csvMatch.ou15} | O3.5%:${csvMatch.ou35} | BTTS%:${csvMatch.btts} | H.CS%:${csvMatch.hcs} | A.CS%:${csvMatch.acs} | H.FTS%:${csvMatch.hfts} | A.FTS%:${csvMatch.afts} | xG.Delta:${csvMatch.xgDelta} | AvgGls:${csvMatch.avgGoals} | Odds.1:${csvMatch.odds1} | Odds.X:${csvMatch.oddsX} | Odds.2:${csvMatch.odds2} | Odds.Over2.5:${csvMatch.oddsOver25} | Odds.Under2.5:${csvMatch.oddsUnder25} | Odds.GG_Yes:${csvMatch.oddsGGYes} | Odds.GG_No:${csvMatch.oddsGGNo} | Odds.O1.5:${csvMatch.oddsO15} | Odds.U1.5:${csvMatch.oddsU15} | CONFLICTS:${cf}`
        : key;
      const parsed = await callClaude(P2_SYS, `Deep analysis today ${TODAY}:\n${line}`, 4000);
      if (Array.isArray(parsed) && parsed[0]) {
        setP2Results(p => { const n = [...p.filter(r => r.match !== key), parsed[0]]; LS.set("fs_p2", n); return n; });
      }
    } catch (e) { setError(`Deep dive failed: ${e.message}`); }
    setDeepLoading(p => { const n = new Set(p); n.delete(key); return n; });
  }

  function scrollToCard(matchName) {
    setTab("results");
    setTimeout(() => { const el = document.getElementById(`card-${matchName.replace(/\s/g, "_")}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100);
  }

  const selCount = selected.size;
  const batchCount = Math.ceil(selCount / BATCH_SIZE);

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="topbar">
          <span className="logo">FIXTURE<em>SCOUT</em></span>
          <span className="topbar-date">{DATE_LABEL}</span>
        </div>
        {(loading || status) && <div className="sbar">{loading && <div className="pulse" />}{status}</div>}
        {error && <div className="ebar">⚠ {error}</div>}
        {batchProg && (
          <div style={{ padding: "6px 16px 0" }}>
            <div className="bbar">
              <div className="bbar-h"><span className="bbar-t">Batch {batchProg.cur}/{batchProg.total}</span><span className="bbar-m">{batchProg.done}/{batchProg.totalM} matches</span></div>
              <div className="prog"><div className="prog-f" style={{ width: `${(batchProg.done / batchProg.totalM) * 100}%` }} /></div>
            </div>
          </div>
        )}

        {/* HOME */}
        {tab === "home" && (
          <div className="screen" style={{ paddingBottom: selCount > 0 ? 88 : 20 }}>
            <div className="csv-panel">
              <div className="csv-head">
                <div>
                  <div className="csv-ttl">Today's Fixtures</div>
                  <div className="csv-sub">Paste CSV from Gemini · Settings has the prompt</div>
                </div>
                {csvSaved && <span className="sv-badge">✓ SAVED</span>}
              </div>
              <textarea className="csv-ta" value={csvText} onChange={e => handleCSV(e.target.value)}
                placeholder={"Game,Date,PPG (Home),PPG (Away),O2.5%,BTTS%,...,Odds.1,Odds.X,Odds.2,...\nArsenal vs. Chelsea,2025-05-14,1.85,1.52,..."} />
              <div className="csv-acts">
                <button className="btn btn-g btn-sm" onClick={saveCSV} disabled={!csvText.trim()}>💾 Save & Load</button>
                <div className="csv-hint">Hash-cached · <em>Results persist until CSV changes</em></div>
              </div>
            </div>
            {matches.length > 0 && (
              <>
                <div className="lh">
                  <div><div className="lh-t">Matches ({matches.length})</div><div className="lh-m">{selCount} selected · {BATCH_SIZE}/batch</div></div>
                  <div className="lh-acts">
                    <button className="btn btn-o btn-sm" onClick={selectAll}>All</button>
                    <button className="btn btn-o btn-sm" onClick={deselectAll}>None</button>
                  </div>
                </div>
                {matches.map(m => {
                  const isTrap = m.conflicts.some(c => c.key === "BTTS_TRAP" || c.key === "OVER_TRAP");
                  const isSurge = m.conflicts.some(c => c.key === "XG_SURGE");
                  const isValue = m.conflicts.some(c => c.key === "HIGH_VALUE");
                  const evO25 = m.preEV?.flag_o25;
                  const evBtts = m.preEV?.flag_btts;
                  return (
                    <div key={m.id} className={`mrow ${selected.has(m.id) ? "sel" : ""} ${isTrap ? "trap" : isSurge ? "surge" : isValue ? "value" : ""}`} onClick={() => toggleMatch(m.id)}>
                      <div className="mt">
                        <div className="mh">{m.home}</div>
                        <div className="mvs">VS</div>
                        <div className="ma">{m.away}</div>
                        <div className="m-meta">
                          <span className="m-sig">Sig <em>{m.signal}</em>/10</span>
                          {m.date && <span className="m-sig">{m.date}</span>}
                          {evO25 && evO25 !== "SKIP" && <span className="m-ev" style={{ color: evO25 === "BET" ? "var(--g)" : "var(--a)" }}>O2.5:{evO25}</span>}
                          {evBtts && evBtts !== "SKIP" && <span className="m-ev" style={{ color: evBtts === "BET" ? "var(--g)" : "var(--a)" }}>BTTS:{evBtts}</span>}
                        </div>
                      </div>
                      <div className="mtags">
                        {m.conflicts.slice(0, 3).map(c => <span key={c.key} className={`tg ${c.cls}`}>{c.label}</span>)}
                        {!m.conflicts.length && m.odds1 && <span className="tg tg-a">1:{m.odds1}</span>}
                      </div>
                      <div className="mcb">{selected.has(m.id) ? "✓" : ""}</div>
                    </div>
                  );
                })}
              </>
            )}
            {!csvText && (
              <div className="empty">
                <div className="ei">📋</div>
                <p>Paste Gemini CSV above<br />Check Settings for the exact prompt</p>
              </div>
            )}
          </div>
        )}

        {/* RESULTS */}
        {tab === "results" && (
          <div className="screen" style={{ paddingBottom: 16 }}>
            {allResults.length === 0 ? (
              <div className="empty"><div className="ei">⚡</div><p>No results yet.<br />Select matches on Fixtures tab → Pass 1.</p></div>
            ) : (
              <>
                <DailyShortlist results={allResults} onScrollTo={scrollToCard} />
                <EdgeBoard results={allResults} onScrollTo={scrollToCard} />
                {p2Results.length > 0 && (
                  <>
                    <div className="sec-lbl">🔍 Deep Analysis ({p2Results.length})</div>
                    {p2Results.map((r, i) => <div key={i} id={`card-${r.match.replace(/\s/g, "_")}`}><DeepCard data={r} /></div>)}
                  </>
                )}
                {p1Results.filter(r => !p2Results.find(p => p.match === r.match)).length > 0 && (
                  <div className="sec-lbl">⚡ Quick Scan ({p1Results.filter(r => !p2Results.find(p => p.match === r.match)).length})</div>
                )}
                {p1Results.filter(r => !p2Results.find(p => p.match === r.match)).map((r, i) => (
                  <div key={i} id={`card-${r.match.replace(/\s/g, "_")}`}>
                    <MatchCard data={r} onDeep={runPass2} deepLoading={deepLoading.has(r.match)} deepDone={false} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab === "acca" && <AccaPanel results={allResults} />}
        {tab === "tracker" && <TrackerPanel results={allResults} />}
        {tab === "settings" && <SettingsScreen onClear={clearAll} />}

        {/* ANALYZE BAR */}
        {tab === "home" && selCount > 0 && (
          <div className="abar">
            <div className="abar-l">
              <span className="abar-c"><em>{selCount}</em> selected · <em>{batchCount}</em> batch{batchCount > 1 ? "es" : ""}</span>
              <span className="abar-b">{BATCH_SIZE} matches per batch</span>
            </div>
            <div className="abar-r">
              {loading && <button className="btn btn-r btn-sm" onClick={() => { abortRef.current = true; }}>■ Stop</button>}
              <button className="btn btn-g btn-sm" onClick={runPass1} disabled={loading}>
                {loading ? "Scanning..." : `⚡ Pass 1 (${selCount})`}
              </button>
            </div>
          </div>
        )}

        {/* BOTTOM NAV */}
        <nav className="bnav">
          {[
            { id: "home", icon: "📋", label: "Fixtures" },
            { id: "results", icon: "⚡", label: `Results${allResults.length ? ` (${allResults.length})` : ""}` },
            { id: "acca", icon: "🎰", label: "Acca" },
            { id: "tracker", icon: "📈", label: "Tracker" },
            { id: "settings", icon: "⚙️", label: "Settings" },
          ].map(n => (
            <button key={n.id} className={`nb ${tab === n.id ? "on" : ""}`} onClick={() => setTab(n.id)}>
              <span className="nb-i">{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}
