/**
 * Herald brain: one conversational turn = a bounded, provider-agnostic tool loop.
 *
 *  - Rolling context: recent conversation text only (older tool results are never
 *    replayed, so every status claim must be re-grounded this turn) plus a fresh
 *    fleet snapshot injected with the user's message.
 *  - Hard caps: tool iterations, tool calls per iteration, wall-clock per turn.
 *  - Strict tool-argument validation: a malformed call gets one corrective error;
 *    a second malformed call ends the turn gracefully. Unvalidated input never
 *    reaches an action tool (propose_input / propose_cush_command).
 */

import type { HeraldMessage } from './protocol';
import { LlmError, LlmProvider, LlmToolCall, LlmTurn, LlmUsage } from './llm/provider';
import { ACTION_TOOLS, TOOL_SPECS, validateToolCall, ToolOutcome } from './tools';
import { clip, SpokenTextFilter } from './text';

export const MAX_TOOL_ITERATIONS = 6;
export const MAX_TOOL_CALLS_PER_ITERATION = 6;
export const MAX_HISTORY_MESSAGES = 16;
const MAX_HISTORY_MESSAGE_CHARS = 1500;
export const TURN_TIMEOUT_MS = 90_000;
/** A sentence end followed by the start of another sentence. */
const NARRATION_BREAK = /[.!?](?:["')\]]*)\s+\S/;
const NARRATION_HOLD_MAX_CHARS = 200;

export interface TurnInput {
  history: HeraldMessage[];
  userText: string;
  snapshot: string;
  /** Volatile per-turn instructions (reply style), appended after the user's words. */
  turnNote?: string;
  systemPrompt: string;
  maxTokens: number;
  signal: AbortSignal;
  onText: (delta: string) => void;
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

export type TurnOutcome = 'ok' | 'tool_limit' | 'malformed' | 'refusal' | 'truncated';

export interface TurnResult {
  text: string;
  outcome: TurnOutcome;
  iterations: number;
  toolCalls: string[];
  usage: Required<LlmUsage>;
  /** Time until the first text actually streamed to the user (after the narration guard). */
  firstTokenMs?: number;
  /** Pre-tool narration sentences that were held back and dropped (for logs). */
  droppedNarration: string[];
}

/** Convert stored conversation into alternating user/assistant turns (text only). */
export function historyToTurns(history: HeraldMessage[]): LlmTurn[] {
  const recent = history
    .filter((m) => m.text && m.text.trim() && !m.streaming)
    .slice(-MAX_HISTORY_MESSAGES);
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of recent) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = clip(m.text.trim(), MAX_HISTORY_MESSAGE_CHARS);
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n${text}`;
    else turns.push({ role, text });
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
  // The new user message is appended by the caller; history must end on assistant.
  while (turns.length > 0 && turns[turns.length - 1].role === 'user') turns.pop();
  return turns;
}

/**
 * Resolve with `p`, or reject with an 'aborted' LlmError as soon as `signal`
 * aborts. Keeps a hung tool / session listing from holding the turn lock past
 * the turn timeout.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LlmError('aborted', 'Turn aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LlmError('aborted', 'Turn aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

const GIVE_UP_TEXT = 'Sorry, I got tangled up on that one. Could you say it another way?';

export async function runTurn(provider: LlmProvider, input: TurnInput): Promise<TurnResult> {
  const turns: LlmTurn[] = [
    ...historyToTurns(input.history),
    {
      role: 'user',
      // The per-turn note sits between the snapshot and the user's words: at the
      // very end, models tend to parrot it back as a closing "[Reply style: ...]".
      text: `${input.snapshot}${input.turnNote ? `\n${input.turnNote}` : ''}\n\n${input.userText}`,
    },
  ];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCallsMade: string[] = [];
  let text = '';
  let firstTokenMs: number | undefined;
  let malformedStrikes = 0;
  let outcome: TurnOutcome = 'ok';
  let iterations = 0;
  const started = Date.now();
  const usedIds = new Set<string>();
  const droppedNarration: string[] = [];

  // Text from successive iterations joins into one reply.
  let iterationHasText = false;
  const spoken = new SpokenTextFilter();
  const emit = (raw: string) => emitFiltered(spoken.push(raw));
  const emitFiltered = (filtered: string) => {
    let delta = filtered;
    if (!delta) return;
    if (!iterationHasText) {
      iterationHasText = true;
      if (text && !/\s$/.test(text)) {
        text += ' ';
        input.onText(' ');
      }
      if (!text) delta = delta.replace(/^\s+/, '');
      if (!delta) {
        iterationHasText = false;
        return;
      }
    }
    if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
    text += delta;
    input.onText(delta);
  };

  // Narration guard: models like to say "Let me check." before calling a tool. That
  // is noise when spoken and reads as a non-answer in the transcript. Each
  // iteration's opening sentence is held back until either a second sentence
  // starts (it is a real answer: stream from then on) or the iteration ends. If
  // the iteration ends in tool calls, a held lone sentence was narration and is
  // dropped; otherwise it is the (short) answer and is flushed.
  let held = '';
  let live = false;
  const hold = (delta: string) => {
    if (live) return emit(delta);
    held += delta;
    if (NARRATION_BREAK.test(held) || held.length > NARRATION_HOLD_MAX_CHARS) {
      live = true;
      const out = held;
      held = '';
      emit(out);
    }
  };

  for (let iter = 0; iter <= MAX_TOOL_ITERATIONS; iter++) {
    if (input.signal.aborted) throw new LlmError('aborted', 'Turn aborted');
    iterations = iter + 1;
    const finalRound = iter === MAX_TOOL_ITERATIONS;
    iterationHasText = false;
    held = '';
    live = false;
    const res = await provider.chat({
      system: input.systemPrompt,
      messages: turns,
      tools: TOOL_SPECS,
      toolChoice: finalRound ? 'none' : 'auto',
      maxTokens: input.maxTokens,
      signal: input.signal,
      onText: hold,
    });
    usage.inputTokens += res.usage.inputTokens || 0;
    usage.outputTokens += res.usage.outputTokens || 0;
    if (held) {
      if (res.toolCalls.length > 0 && !finalRound && res.stopReason !== 'refusal') {
        droppedNarration.push(held.trim());
      } else {
        emit(held);
      }
      held = '';
    }
    // Release anything the filter still holds (a "[" that never closed).
    emitFiltered(spoken.flush());

    if (res.stopReason === 'refusal') {
      outcome = 'refusal';
      if (!text.trim()) emit("I can't help with that one.");
      break;
    }
    if (res.toolCalls.length === 0) {
      if (res.stopReason === 'max_tokens') outcome = 'truncated';
      break;
    }
    if (finalRound) {
      // The model kept calling tools after we asked for a plain answer.
      outcome = 'tool_limit';
      break;
    }

    // Local servers may omit or reuse call ids; ids must be unique within the turn.
    const allCalls: LlmToolCall[] = res.toolCalls.map((c, i) => {
      let id = c.id || `call_${iter}_${i}`;
      if (usedIds.has(id)) id = `${id}_${iter}_${i}`;
      usedIds.add(id);
      return { ...c, id };
    });
    const calls = allCalls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
    const skipped = allCalls.slice(MAX_TOOL_CALLS_PER_ITERATION);
    turns.push({ role: 'assistant', text: res.text, toolCalls: allCalls });

    // Validate everything first; a truncated response (max_tokens) means the
    // arguments cannot be trusted even if they happen to parse.
    const truncated = res.stopReason === 'max_tokens';
    const validated = calls.map((c) =>
      truncated
        ? ({
            ok: false,
            error: 'Your tool call was cut off. Keep arguments short and try again.',
          } as const)
        : validateToolCall(c.name, c.arguments)
    );
    const anyMalformed = validated.some((v) => !v.ok);
    if (anyMalformed && malformedStrikes >= 1) {
      outcome = 'malformed';
      console.log(
        `Herald: giving up after repeated malformed tool calls: ${calls.map((c) => `${c.name}(${clip(c.arguments, 120)})`).join(', ')}`
      );
      emit(GIVE_UP_TEXT);
      break;
    }
    if (anyMalformed) malformedStrikes++;

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const v = validated[i];
      let result: ToolOutcome;
      if (!v.ok) {
        result = {
          content: JSON.stringify({ error: `${v.error} Correct the call and try again.` }),
          isError: true,
        };
      } else if (anyMalformed && ACTION_TOOLS.has(c.name)) {
        // Never act in an iteration where the model produced malformed calls.
        result = {
          content: JSON.stringify({
            error:
              'Not executed because another call in this step was malformed. Retry with valid arguments.',
          }),
          isError: true,
        };
      } else {
        if (input.signal.aborted) throw new LlmError('aborted', 'Turn aborted');
        toolCallsMade.push(c.name);
        result = await raceAbort(input.runTool(c.name, v.value), input.signal);
      }
      turns.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: result.content,
        isError: result.isError,
      });
    }
    // Calls beyond the per-iteration cap still need a result so history stays valid.
    for (const c of skipped) {
      turns.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: '{"error":"Too many tool calls at once; skipped."}',
        isError: true,
      });
    }
  }

  return {
    text: text.trim(),
    outcome,
    iterations,
    toolCalls: toolCallsMade,
    usage,
    firstTokenMs,
    droppedNarration,
  };
}
