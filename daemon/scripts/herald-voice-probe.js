#!/usr/bin/env node
/**
 * herald-voice-probe: live checks of Herald voice through a daemon's WebSocket,
 * exactly as the web client does it. Targets the throwaway PROBE instance
 * (bin/herald-sandbox --instance probe start, port 9888) by default. Never
 * point it at the 9887 sandbox: that conversation is the user's live history.
 *
 *   node scripts/herald-voice-probe.js status
 *   node scripts/herald-voice-probe.js tts "Anything for me?" [--out dir]
 *       Sends a Herald turn, chunks the streamed reply into sentences (same
 *       rules as the web: first sentence clause-split), requests herald_tts for
 *       each as soon as it completes, and reports message_start -> first audio,
 *       per-sentence synthesis real-time factor, and writes reply.wav.
 *   node scripts/herald-voice-probe.js stt "Sentence to synthesize, then transcribe."
 *       Synthesizes with Kokoro (herald_tts), resamples to 16 kHz, streams it as
 *       100 ms herald_voice_audio chunks, and transcribes (herald_voice_stream_end).
 *   node scripts/herald-voice-probe.js wake "Hey Jarvis, anything for me?"
 *       Streams synthesized speech in real time as a wake stream; reports the
 *       detection delay after the wake word and the stripped transcript.
 *
 * SAFETY: any Herald action proposed during a tts turn is cancelled at once.
 * Audio is written only when --out is given (default: none for stt/wake).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = { out: null, config: null, url: null, voice: null, texts: [] };
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--out') opts.out = argv[++i];
  else if (argv[i] === '--config') opts.config = argv[++i];
  else if (argv[i] === '--url') opts.url = argv[++i];
  else if (argv[i] === '--voice') opts.voice = argv[++i];
  else opts.texts.push(argv[i]);
}
if (!['status', 'tts', 'stt', 'wake'].includes(cmd)) {
  console.error('usage: herald-voice-probe.js status|tts|stt|wake "text" [--out dir] [--voice af_heart]');
  process.exit(2);
}
const sandboxBase = process.env.HERALD_SANDBOX_DIR || path.join(os.homedir(), '.cache', 'companion-herald-sandbox');
opts.config = opts.config || `${sandboxBase}-probe/config.json`;
if (!fs.existsSync(opts.config)) {
  console.error(`config not found: ${opts.config}\nStart it first: bin/herald-sandbox --instance probe start`);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(opts.config, 'utf-8'));
const listener = (cfg.listeners && cfg.listeners[0]) || { port: cfg.port, token: cfg.token };
const url = opts.url || `ws://localhost:${listener.port}`;
if (/:9887\b/.test(url)) {
  console.error('refusing to probe 9887 (the user\'s live sandbox)');
  process.exit(2);
}

const ws = new WebSocket(url);
let seq = 0;
const waiters = new Map();
const heraldListeners = new Set();
const voiceListeners = new Set();

function request(type, payload, timeoutMs = 30_000) {
  const requestId = `vprobe-${++seq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    waiters.set(requestId, (msg) => {
      clearTimeout(t);
      if (msg.success === false) reject(new Error(`${type}: ${msg.error}`));
      else resolve(msg.payload);
    });
    ws.send(JSON.stringify({ type, payload, requestId, ...(type === 'authenticate' ? { token: listener.token } : {}) }));
  });
}
const fire = (type, payload) => ws.send(JSON.stringify({ type, payload }));

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
    return w(msg);
  }
  if (msg.type === 'herald_event') heraldListeners.forEach((l) => l(msg.payload));
  if (msg.type === 'herald_voice_event') voiceListeners.forEach((l) => l(msg.payload));
});

// Safety net: cancel any pending action we ever see.
const cancelled = new Set();
heraldListeners.add((ev) => {
  const acts = ev.kind === 'action' ? [ev.action] : ev.kind === 'state' ? ev.state.actions : [];
  for (const a of acts || []) {
    if (a.status === 'pending' && !cancelled.has(a.id)) {
      cancelled.add(a.id);
      request('herald_confirm', { actionId: a.id, decision: 'cancel' }).then(
        () => console.log(`  [safety] cancelled proposed action: ${a.readback}`),
        () => {}
      );
    }
  }
});

// ---- helpers ---------------------------------------------------------------

/** Sentence chunker equivalent to the web's (sentence end + whitespace). */
function makeChunker() {
  let buf = '';
  return {
    push(delta) {
      buf += delta;
      const out = [];
      const re = /[.!?]["')\]]*\s+|\n{2,}/g;
      let m;
      let last = 0;
      while ((m = re.exec(buf))) {
        const s = buf.slice(last, m.index + m[0].length).trim();
        if (s) out.push(s);
        last = m.index + m[0].length;
      }
      buf = buf.slice(last);
      return out;
    },
    flush() {
      const s = buf.trim();
      buf = '';
      return s ? [s] : [];
    },
  };
}

/** Same rule as web/src/services/tts/serverTtsEngine.ts splitForFastStart. */
function splitForFastStart(text) {
  if (text.length < 70) return [text];
  const re = /[,;:—–]\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const cut = m.index + 1;
    if (cut < 16) continue;
    if (cut > 90) break;
    const head = text.slice(0, cut).trim();
    const tail = text.slice(m.index + m[0].length).trim();
    if (tail.length < 12) break;
    return [head, tail];
  }
  return [text];
}

function speechText(s) {
  return s.replace(/\*\*|__|`|#+\s/g, '').replace(/\s+/g, ' ').trim();
}

function wav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 24 kHz -> 16 kHz PCM16 (linear interpolation; fine for speech). */
function resample24to16(pcm24) {
  const inN = pcm24.length / 2;
  const outN = Math.floor((inN * 2) / 3);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * 3) / 2;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = pcm24.readInt16LE(i0 * 2);
    const b = i0 + 1 < inN ? pcm24.readInt16LE((i0 + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}

async function synth16k(text) {
  const r = await request('herald_tts', { text, voice: opts.voice || 'am_michael', speed: 1 });
  return { pcm: resample24to16(Buffer.from(r.audio, 'base64')), synthMs: r.synthMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamAudio(streamId, pcm, realtime) {
  const CHUNK = 3200; // 100 ms
  for (let i = 0, n = 0; i < pcm.length; i += CHUNK, n++) {
    fire('herald_voice_audio', { streamId, seq: n, pcm: pcm.subarray(i, i + CHUNK).toString('base64') });
    if (realtime) await sleep(100);
  }
}

// ---- commands --------------------------------------------------------------

async function cmdStatus() {
  const st = await request('herald_voice_status', {});
  console.log(JSON.stringify({ ...st, tts: { ...st.tts, voices: st.tts.voices.length } }, null, 2));
}

async function cmdTts(question) {
  const t0 = Date.now();
  let startAt = null;
  let firstDeltaAt = null;
  let replyId = null;
  const chunker = makeChunker();
  const jobs = [];
  let first = true;
  let text = '';
  const say = (s) => {
    const clean = speechText(s);
    if (!clean) return;
    const pieces = first ? splitForFastStart(clean) : [clean];
    first = false;
    for (const p of pieces) {
      const requestedAt = Date.now();
      jobs.push(
        request('herald_tts', { text: p, voice: opts.voice || null, speed: 1.05 }, 60_000).then((r) => ({
          text: p,
          requestedAt,
          doneAt: Date.now(),
          ...r,
        }))
      );
    }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply in 90s')), 90_000);
    const onEv = (ev) => {
      if (ev.kind === 'message_start' && ev.message.role === 'herald') {
        replyId = ev.message.id;
        startAt = Date.now();
        if (ev.message.text) {
          text += ev.message.text;
          chunker.push(ev.message.text).forEach(say);
        }
      } else if (ev.kind === 'message_delta' && ev.messageId === replyId) {
        if (firstDeltaAt === null) firstDeltaAt = Date.now();
        text += ev.delta;
        chunker.push(ev.delta).forEach(say);
      } else if (ev.kind === 'message_end' && ev.message.id === replyId) {
        if (ev.message.text.length > text.length) chunker.push(ev.message.text.slice(text.length)).forEach(say);
        chunker.flush().forEach(say);
        text = ev.message.text;
        clearTimeout(timer);
        heraldListeners.delete(onEv);
        resolve();
      }
    };
    heraldListeners.add(onEv);
    request('herald_send', { text: question }).catch(reject);
  });
  const results = await Promise.all(jobs);
  if (!results.length) throw new Error('reply had nothing speakable');
  const firstAudioMs = results[0].doneAt - startAt;
  console.log(`reply: ${text}`);
  console.log(`send -> message_start: ${startAt - t0} ms`);
  console.log(`message_start -> first audio ready: ${firstAudioMs} ms  (first chunk: "${results[0].text}")`);
  console.log(`  of which: message_start -> first token ${firstDeltaAt ? firstDeltaAt - startAt : 'n/a'} ms (LLM), ` +
    `first token -> first sentence complete ${firstDeltaAt ? results[0].requestedAt - firstDeltaAt : 'n/a'} ms, ` +
    `sentence -> audio ready ${results[0].doneAt - results[0].requestedAt} ms (synthesis ${results[0].synthMs} ms + transport)`);
  let synth = 0;
  let audio = 0;
  for (const r of results) {
    synth += r.synthMs;
    audio += r.audioMs;
    console.log(`  ${String(r.synthMs).padStart(5)} ms synth / ${String(r.audioMs).padStart(5)} ms audio  rtf ${(r.synthMs / r.audioMs).toFixed(2)}  "${r.text}"`);
  }
  console.log(`overall synthesis RTF: ${(synth / audio).toFixed(2)} (${results.length} chunks, ${(audio / 1000).toFixed(1)} s audio)`);
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    const pcm = Buffer.concat(results.map((r) => Buffer.from(r.audio, 'base64')));
    const file = path.join(opts.out, 'reply.wav');
    fs.writeFileSync(file, wav(pcm, results[0].sampleRate));
    console.log(`wrote ${file}`);
  }
}

async function cmdStt(text) {
  const { pcm, synthMs } = await synth16k(text);
  console.log(`synthesized ${(pcm.length / 32000).toFixed(2)} s of speech in ${synthMs} ms`);
  const streamId = `probe-stt-${Date.now()}`;
  await request('herald_voice_stream_start', { streamId, purpose: 'stt', sampleRate: 16000 });
  await streamAudio(streamId, pcm, false);
  const t = Date.now();
  const r = await request('herald_voice_stream_end', { streamId, action: 'transcribe' });
  const rtt = Date.now() - t;
  console.log(`transcript: "${r.text}"`);
  console.log(`expected:   "${text}"`);
  console.log(`release -> transcript: ${rtt} ms (whisper ${r.sttMs} ms for ${r.audioMs} ms audio)`);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  console.log(norm(r.text) === norm(text) ? 'MATCH' : 'MISMATCH');
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'stt-input-16k.wav'), wav(pcm, 16000));
  }
}

async function cmdWake(text) {
  // Where does the wake word end? Synthesize the wake phrase alone for its length.
  const wakeOnly = await synth16k('Hey Jarvis.');
  const full = await synth16k(text);
  const lead = Buffer.alloc(16000); // 0.5 s of silence (VAD pre-roll)
  const pcm = Buffer.concat([lead, full.pcm]);
  const wakeEndS = 0.5 + wakeOnly.pcm.length / 32000 - 0.25; // minus the trailing pause Kokoro adds
  const streamId = `probe-wake-${Date.now()}`;
  let wokeAt = null;
  let score = null;
  voiceListeners.add((ev) => {
    if (ev.kind === 'wake' && ev.streamId === streamId && wokeAt === null) {
      wokeAt = Date.now();
      score = ev.score;
    }
    if (ev.kind === 'stream_error') console.log(`stream_error: ${ev.error}`);
  });
  await request('herald_voice_stream_start', { streamId, purpose: 'wake', sampleRate: 16000 });
  const t0 = Date.now();
  await streamAudio(streamId, pcm, true);
  await sleep(600);
  const r = await request('herald_voice_stream_end', { streamId, action: 'transcribe' });
  if (wokeAt === null) {
    console.log('wake word NOT detected');
  } else {
    const delay = wokeAt - t0 - wakeEndS * 1000;
    console.log(`wake detected (score ${score}) ${wokeAt - t0} ms after stream start; ~${Math.round(delay)} ms after the wake word ended`);
  }
  console.log(`woke=${r.woke} transcript (wake phrase stripped): "${r.text}" (whisper ${r.sttMs} ms)`);
}

ws.on('error', (e) => {
  console.error(`WebSocket error: ${e.message}`);
  process.exit(1);
});
ws.on('open', async () => {
  try {
    await request('authenticate', {});
    await request('subscribe', {});
    const st = await request('herald_voice_status', {});
    if (!st.available && cmd !== 'status') throw new Error('voice service unavailable (bin/herald-voice status)');
    if (cmd === 'status') await cmdStatus();
    else if (cmd === 'tts') await cmdTts(opts.texts[0] || 'Anything for me?');
    else if (cmd === 'stt') await cmdStt(opts.texts[0] || 'Tell the companion session to run the web tests.');
    else if (cmd === 'wake') await cmdWake(opts.texts[0] || 'Hey Jarvis, anything for me?');
  } catch (e) {
    console.error(`probe failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    ws.close();
    setTimeout(() => process.exit(), 200);
  }
});
