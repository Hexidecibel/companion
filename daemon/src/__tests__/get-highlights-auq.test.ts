import * as fs from 'fs';
import * as path from 'path';
import { registerSessionHandlers } from '../handlers/session';
import { parseConversationFile } from '../parser';
import { defaultAgent } from '../agents';
import type { HandlerContext } from '../handler-context';
import type { ConversationHighlight, ConversationMessage } from '../types';

const FX = path.join(__dirname, 'fixtures', 'cc-contract');
const pane = fs.readFileSync(path.join(FX, 'auq-cc2.1.323-multi-question-w120-s1.txt'), 'utf8');

/** The transcript as Claude Code sometimes writes it: the AUQ tool_use BEFORE it is answered. */
function pendingAuqTranscript(): ConversationMessage[] {
  const toolUse = JSON.parse(
    fs.readFileSync(path.join(FX, 'auq-cc2.1.323-multi-question-w120.jsonl'), 'utf8').split('\n')[0]
  ) as { id: string; name: string; input: Record<string, unknown> };
  const entries = [
    {
      type: 'user',
      message: { role: 'user', content: 'Ask me about dinner' },
      uuid: 'u1',
      timestamp: '2026-11-15T10:00:00.000Z',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }],
      },
      uuid: 'a1',
      timestamp: '2026-11-15T10:00:05.000Z',
    },
  ];
  return parseConversationFile(
    'pending.jsonl',
    Infinity,
    entries.map((e) => JSON.stringify(e)).join('\n')
  );
}

function makeCtx(messages: ConversationMessage[], paneText: string) {
  const sent: Array<{ payload?: { highlights: ConversationHighlight[]; total: number } }> = [];
  const ctx = {
    send: jest.fn((_ws: unknown, msg: (typeof sent)[number]) => sent.push(msg)),
    injector: { captureTmuxPane: jest.fn(() => Promise.resolve(paneText)) },
    watcher: {
      getActiveSessionId: jest.fn(() => 'sess'),
      getConversationChain: jest.fn(() => []),
      ensureConversationLoaded: jest.fn(() => false),
      getFreshMessages: jest.fn(() => messages),
      getMessages: jest.fn(() => messages),
      getRecaps: jest.fn(() => []),
      getStatus: jest.fn(() => ({ isWaitingForInput: true })),
      getTmuxSessionForConversation: jest.fn(() => null),
      getSessions: jest.fn(() => [{ name: 'sess' }]),
      noteStartupPane: jest.fn(),
      agentFor: jest.fn(() => defaultAgent()),
      pendingPromptFor: jest.fn(() => null),
      followLiveChoice: jest.fn(),
    },
    pendingSentMessages: new Map(),
    PENDING_SENT_TTL: 60_000,
  };
  const handlers = registerSessionHandlers(ctx as unknown as HandlerContext);
  return { ctx, handlers, sent };
}

describe('get_highlights with a pending AskUserQuestion already in the transcript', () => {
  it('still captures the pane; the live box replaces the transcript card (one card, live)', async () => {
    const messages = pendingAuqTranscript();
    // precondition: the transcript alone yields a tappable pending AUQ
    expect(messages[messages.length - 1].questions).toHaveLength(3);

    const { ctx, handlers, sent } = makeCtx(messages, pane);
    await handlers.get_highlights({ ws: {} } as never, { sessionId: 'sess' }, 'r1');

    expect(ctx.injector.captureTmuxPane).toHaveBeenCalledWith('sess', 30, { ansi: true });
    const { highlights, total } = sent[0].payload!;
    const waiting = highlights.filter((h) => h.isWaitingForChoice);
    expect(waiting).toHaveLength(1);
    const card = waiting[0];
    expect(card).toBe(highlights[highlights.length - 1]);
    expect(card.liveSourced).toBe(true);
    expect(card.questions).toHaveLength(1);
    expect(card.questions![0].question).toBe('Which main course?');
    expect(card.questions![0].options.map((o) => o.label)).toEqual(['Pasta', 'Curry']);
    expect(card.questions![0].live).toMatchObject({
      screen: 'question',
      questionIndex: 0,
      questionCount: 3,
    });
    // the transcript's tool call stays on the bubble
    expect(card.toolCalls?.some((t) => t.name === 'AskUserQuestion')).toBe(true);
    // replaced, not appended
    expect(total).toBe(highlights.length);
    expect(ctx.watcher.followLiveChoice).toHaveBeenCalledTimes(1);
  });

  it('keeps the transcript card when the pane shows no live AUQ box', async () => {
    const messages = pendingAuqTranscript();
    const { ctx, handlers, sent } = makeCtx(messages, 'just some shell output\n> ');
    await handlers.get_highlights({ ws: {} } as never, { sessionId: 'sess' }, 'r1');

    expect(ctx.injector.captureTmuxPane).toHaveBeenCalled();
    const last = sent[0].payload!.highlights.slice(-1)[0];
    expect(last.isWaitingForChoice).toBe(true);
    expect(last.questions).toHaveLength(3);
    expect(last.liveSourced).toBeUndefined();
    expect(ctx.watcher.followLiveChoice).not.toHaveBeenCalled();
  });

  it('a non-AUQ transcript choice (tool approval options) still skips the capture', async () => {
    const messages: ConversationMessage[] = [
      {
        id: 'a1',
        type: 'assistant',
        content: 'Do you want to proceed?',
        timestamp: 1,
        isWaitingForChoice: true,
        options: [{ label: 'Yes' }, { label: 'No' }],
      } as ConversationMessage,
    ];
    const { ctx, handlers, sent } = makeCtx(messages, pane);
    await handlers.get_highlights({ ws: {} } as never, { sessionId: 'sess' }, 'r1');

    expect(ctx.injector.captureTmuxPane).not.toHaveBeenCalled();
    const { highlights } = sent[0].payload!;
    expect(highlights).toHaveLength(1);
    expect(highlights[0].liveSourced).toBeUndefined();
  });
});
