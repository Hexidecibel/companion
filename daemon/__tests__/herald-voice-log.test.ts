import { HeraldVoiceService } from '../src/herald/voice/service';
import { RateLimitedLog } from '../src/herald/voice/rate-log';

const pcm = (samples: number) => Buffer.alloc(samples * 2).toString('base64');
const flush = () => new Promise((r) => setImmediate(r));

function fakeClient(wakeScores: number[]) {
  return {
    baseUrl: 'http://127.0.0.1:9889',
    health: jest.fn(async () => null),
    stt: jest.fn(async () => ({ text: 'Hey Jarvis, anything for me?', audioMs: 1000, sttMs: 40 })),
    wake: jest.fn(async () => {
      const score = wakeScores.shift() ?? 0;
      return { detected: score >= 0.5, score, model: 'hey_jarvis' };
    }),
    dropWake: jest.fn(async () => undefined),
  } as any;
}

describe('Herald voice: info logging (wake streams, detections, hands-free)', () => {
  it('logs a wake stream start, the detection with its score, and the end with the outcome', async () => {
    const lines: string[] = [];
    const svc = new HeraldVoiceService({
      client: fakeClient([0.12, 0.95]),
      sendEvent: () => {},
      log: (l) => lines.push(l),
    });
    svc.setPresence('client-aaaaaaaa', { label: 'Mac desktop' });
    svc.startStream('client-aaaaaaaa', { streamId: 'w1', purpose: 'wake', sampleRate: 16000 });
    svc.pushAudio('client-aaaaaaaa', { streamId: 'w1', seq: 0, pcm: pcm(1600) });
    await flush();
    svc.pushAudio('client-aaaaaaaa', { streamId: 'w1', seq: 1, pcm: pcm(1600) });
    await flush();
    await svc.endStream('client-aaaaaaaa', { streamId: 'w1', action: 'discard' });
    expect(lines[0]).toBe(
      'Herald voice: wake stream start client=client-a (Mac desktop) stream=w1'
    );
    expect(lines[1]).toMatch(
      /wake detected client=client-a \(Mac desktop\) stream=w1 score=0\.950 model=hey_jarvis/
    );
    // The case seen in production: woken, then discarded by the client.
    expect(lines[2]).toMatch(
      /wake stream end client=client-a \(Mac desktop\) stream=w1 discard woke=true audioMs=200 bestScore=0\.950/
    );
    // No audio, no transcripts in any line.
    expect(lines.join('\n')).not.toMatch(/anything for me/i);
  });

  it('logs hands-free stand-down decisions', () => {
    const lines: string[] = [];
    const svc = new HeraldVoiceService({
      client: fakeClient([]),
      sendEvent: () => {},
      log: (l) => lines.push(l),
    });
    svc.setPresence('aaaaaaaa-1', { label: 'Mac desktop' });
    svc.setPresence('bbbbbbbb-2', { label: 'Windows desktop' });
    svc.setHandsFree('aaaaaaaa-1', true);
    svc.setHandsFree('bbbbbbbb-2', true);
    svc.setHandsFree('bbbbbbbb-2', false);
    expect(lines).toEqual([
      'Herald voice: hands-free on client=aaaaaaaa (Mac desktop)',
      'Herald voice: hands-free on client=bbbbbbbb (Windows desktop); stood down client=aaaaaaaa (Mac desktop) (only one device listens)',
      'Herald voice: hands-free off client=bbbbbbbb (Windows desktop)',
    ]);
  });

  it('rate limits each kind and reports how many lines it suppressed', () => {
    const lines: string[] = [];
    let t = 0;
    const log = new RateLimitedLog(
      (l) => lines.push(l),
      () => t,
      3,
      1000
    );
    for (let i = 0; i < 10; i++) log.log('wake_stream', `line ${i}`);
    log.log('handsfree', 'other kind');
    expect(lines).toEqual(['line 0', 'line 1', 'line 2', 'other kind']);
    t = 1000;
    log.log('wake_stream', 'next window');
    expect(lines.slice(4)).toEqual([
      'Herald voice: 7 more "wake_stream" log lines suppressed',
      'next window',
    ]);
  });
});
