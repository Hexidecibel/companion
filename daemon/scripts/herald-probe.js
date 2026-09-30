#!/usr/bin/env node
/**
 * herald-probe: drive a Herald-enabled daemon over the WebSocket protocol and
 * measure it. Intended for the isolated bin/herald-sandbox daemon.
 *
 *   node scripts/herald-probe.js --config <sandbox config.json> [--url ws://localhost:9887] \
 *     [--reset] [--json out.json] "Anything for me?" "What's everyone working on?" ...
 *
 * For each question: sends herald_send, streams herald_event pushes, and reports
 * client-observed time-to-first-token, total latency, the verbatim reply, tool
 * refs and any proposed actions.
 *
 * SAFETY: every proposed action is CANCELLED the moment it is seen (herald_confirm
 * decision=cancel), long before the echo window elapses, so nothing is ever typed
 * into a real session. The probe never sends decision=confirm.
 */

'use strict';

const fs = require('fs');
const WebSocket = require('ws');

function parseArgs(argv) {
  const out = { url: null, config: null, reset: false, json: null, questions: [], timeoutMs: 60_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--reset') out.reset = true;
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]) * 1000;
    else out.questions.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error('usage: herald-probe.js --config <config.json> [--url ws://host:port] [--reset] [--json out] "question" ...');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(args.config, 'utf-8'));
const listener = (cfg.listeners && cfg.listeners[0]) || { port: cfg.port, token: cfg.token };
const url = args.url || `ws://localhost:${listener.port}`;
const token = listener.token;

const ws = new WebSocket(url);
let reqSeq = 0;
const waiters = new Map();
const eventListeners = new Set();

function request(type, payload) {
  const requestId = `probe-${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, 15_000);
    waiters.set(requestId, (msg) => {
      clearTimeout(t);
      if (msg.success === false) reject(new Error(`${type}: ${msg.error}`));
      else resolve(msg.payload !== undefined ? msg.payload : msg);
    });
    ws.send(JSON.stringify({ type, payload, requestId, ...(type === 'authenticate' ? { token } : {}) }));
  });
}

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.requestId && waiters.has(msg.requestId)) {
    const w = waiters.get(msg.requestId);
    waiters.delete(msg.requestId);
    w(msg);
    return;
  }
  if (msg.type === 'herald_event') for (const l of eventListeners) l(msg.payload);
});

const cancelled = new Set();
async function cancelIfPending(action) {
  if (!action || action.status !== 'pending' || cancelled.has(action.id)) return;
  cancelled.add(action.id);
  try {
    const res = await request('herald_confirm', { actionId: action.id, decision: 'cancel' });
    console.log(`    [safety] cancelled proposed action ${action.id} -> ${res.status} (${action.tier}: ${action.readback})`);
  } catch (e) {
    console.log(`    [safety] cancel failed for ${action.id}: ${e.message}`);
  }
}
// Global safety net: cancel ANY pending action we ever observe.
eventListeners.add((ev) => {
  if (ev.kind === 'action') void cancelIfPending(ev.action);
  if (ev.kind === 'state') for (const a of ev.state.actions || []) void cancelIfPending(a);
});

function ask(question) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let ttft = null;
    let replyId = null;
    const events = [];
    const actions = [];
    let finalMsg = null;
    let errorEv = null;
    let busyOff = false;

    const done = () => {
      eventListeners.delete(onEvent);
      clearTimeout(timer);
      resolve({
        question,
        ttftMs: ttft,
        totalMs: Date.now() - t0,
        reply: finalMsg ? finalMsg.text : null,
        sessionRefs: finalMsg && finalMsg.sessionRefs ? finalMsg.sessionRefs.map((r) => r.sessionName) : [],
        actions,
        error: errorEv,
        eventCounts: events.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {}),
      });
    };
    const onEvent = (ev) => {
      events.push(ev.kind);
      if (ev.kind === 'message_start' && ev.message.role === 'herald') replyId = ev.message.id;
      if (ev.kind === 'message_delta' && ev.messageId === replyId && ttft === null) ttft = Date.now() - t0;
      if (ev.kind === 'message_end' && ev.message.role === 'herald' && ev.message.id === replyId) finalMsg = ev.message;
      if (ev.kind === 'action') actions.push({ tier: ev.action.tier, status: ev.action.status, readback: ev.action.readback, reasons: ev.action.reasons });
      if (ev.kind === 'error') errorEv = ev.error;
      if (ev.kind === 'busy' && ev.busy === false) busyOff = true;
      if (busyOff && finalMsg) setTimeout(done, 300); // let trailing action events land
    };
    eventListeners.add(onEvent);
    const timer = setTimeout(() => {
      eventListeners.delete(onEvent);
      reject(new Error(`no reply within ${args.timeoutMs / 1000}s`));
    }, args.timeoutMs);
    request('herald_send', { text: question }).catch((e) => {
      eventListeners.delete(onEvent);
      clearTimeout(timer);
      reject(e);
    });
  });
}

ws.on('error', (e) => {
  console.error(`WebSocket error: ${e.message}`);
  process.exit(1);
});

ws.on('open', async () => {
  const report = { url, state: null, turns: [] };
  try {
    await request('authenticate', {});
    await request('subscribe', {});
    if (args.reset) {
      await request('herald_reset', {});
      console.log('Conversation reset.');
    }
    const st = await request('herald_get_state', {});
    report.state = { enabled: st.enabled, disabledReason: st.disabledReason, model: st.model, inbox: st.inbox, pendingActions: st.actions.filter((a) => a.status === 'pending').length };
    console.log(`Herald "${st.displayName}" enabled=${st.enabled} model=${st.model}${st.disabledReason ? ` reason=${st.disabledReason}` : ''}`);
    console.log(`Inbox (${st.inbox.length}):`);
    for (const i of st.inbox) console.log(`  [${i.priority}${i.heard ? '' : ', unheard'}] ${i.sessionName}: ${i.headline}`);
    for (const a of st.actions) await cancelIfPending(a);

    for (const q of args.questions) {
      console.log(`\n> ${q}`);
      const r = await ask(q);
      report.turns.push(r);
      console.log(`  ttft=${r.ttftMs ?? 'n/a'}ms total=${r.totalMs}ms events=${JSON.stringify(r.eventCounts)}`);
      if (r.error) console.log(`  ERROR: ${r.error}`);
      console.log(`  refs: ${r.sessionRefs.join(', ') || 'none'}`);
      if (r.actions.length) console.log(`  actions: ${JSON.stringify(r.actions)}`);
      console.log(`  reply: ${r.reply}`);
    }
  } catch (e) {
    console.error(`probe failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    ws.close();
    setTimeout(() => process.exit(), 200);
  }
});
