import { describe, expect, it } from 'vitest';
import { HeraldAudioGraph, clampCurve, clampSample } from '../audioGraph';
import { busGains } from '../../tts/volume';

// A tiny fake WebAudio: nodes record what they connect to, so the graph's
// topology (and where the echo reference is taken) can be checked.
class FakeNode {
  out: Array<{ node: FakeNode; input: number }> = [];
  gain = { value: 1 };
  curve: Float32Array | null = null;
  oversample = 'none';
  channelCount = 2;
  channelCountMode = 'max';
  constructor(readonly kind: string) {}
  connect(node: FakeNode, _output = 0, input = 0) {
    this.out.push({ node, input });
    return node;
  }
  disconnect() {
    this.out = [];
  }
}

class FakeContext {
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  destination = new FakeNode('destination');
  createGain() { return new FakeNode('gain'); }
  createWaveShaper() { return new FakeNode('shaper'); }
  createMediaStreamDestination() { return Object.assign(new FakeNode('msd'), { stream: {} }); }
}

function withFakeAudio<T>(fn: () => T): T {
  const w = window as unknown as { AudioContext?: unknown };
  const prev = w.AudioContext;
  w.AudioContext = FakeContext;
  try {
    return fn();
  } finally {
    w.AudioContext = prev;
  }
}

/** Every node downstream of `from`. */
function reach(from: FakeNode): Set<FakeNode> {
  const seen = new Set<FakeNode>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    for (const { node } of n.out) if (!seen.has(node)) { seen.add(node); stack.push(node); }
  }
  return seen;
}

/** Gain from `from` to `to` along the (single) path: the product of the gain nodes passed. */
function pathGain(from: FakeNode, to: FakeNode): number | null {
  if (from === to) return 1;
  const own = from.kind === 'gain' ? from.gain.value : 1;
  for (const { node } of from.out) {
    const g = pathGain(node, to);
    if (g !== null) return own * g;
  }
  return null;
}

describe('Herald volume in the audio graph', () => {
  it('voice and tones pass their gains, then the clamp; the echo reference is AFTER all of it', () => {
    withFakeAudio(() => {
      const g = new HeraldAudioGraph();
      const voice = g.voiceBus() as unknown as FakeNode;
      const tones = g.toneBus() as unknown as FakeNode;
      const ref = g.referenceNode() as unknown as FakeNode;
      const dest = (g.context() as unknown as FakeContext).destination;
      expect(ref.kind).toBe('shaper');
      // The reference node feeds the speakers: what the canceller gets is what plays.
      expect(ref.out.map((o) => o.node)).toContain(dest);
      expect(reach(voice).has(ref)).toBe(true);
      expect(reach(tones).has(ref)).toBe(true);
      // Nothing bypasses the reference on its way to the speakers.
      const pb = g.playbackBus() as unknown as FakeNode;
      expect(pb.out.map((o) => o.node)).toEqual([ref]);

      const v = busGains({ voice: 1.3, tones: 0.5, tonesFollowVoice: true });
      g.setVolume(v.voice, v.tones);
      expect(voice.gain.value).toBe(1.3);
      expect(tones.gain.value).toBe(0.65);
      expect(pathGain(voice, ref)).toBeCloseTo(1.3);
      expect(pathGain(tones, ref)).toBeCloseTo(0.65);
    });
  });

  it('a volume set before the context exists applies when it is built', () => {
    withFakeAudio(() => {
      const g = new HeraldAudioGraph();
      g.setVolume(0.8, 0.4);
      expect((g.voiceBus() as unknown as FakeNode).gain.value).toBe(0.8);
      expect((g.toneBus() as unknown as FakeNode).gain.value).toBe(0.4);
    });
  });

  it('the clamp is identity in range and limits a boost exactly like the speakers', () => {
    expect(Array.from(clampCurve())).toEqual([-1, 1]);
    for (const x of [-0.9, -0.2, 0, 0.33, 0.99]) expect(clampSample(x)).toBe(x);
    // A 0.8 peak at 150 % plays (and is referenced) as a clipped 1.0.
    expect(clampSample(0.8 * 1.5)).toBe(1);
    expect(clampSample(-0.8 * 1.5)).toBe(-1);
  });
});
