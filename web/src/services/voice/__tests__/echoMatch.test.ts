import { describe, expect, it } from 'vitest';
import { echoScore, echoWords, isLikelyEcho, soundKey } from '../echoMatch';

// Real production sequence (macOS app, speakers): Herald said this, then these
// "user" messages arrived seconds apart.
const SAID = 'Doc Upload Site shipped v2.28.0 to supdox.com. The deploy checks passed.';

describe('echoWords / soundKey', () => {
  it('drops punctuation, splits letters from digits and spells numbers out', () => {
    expect(echoWords('Shift V2.')).toEqual(['shift', 'v', 'two']);
    expect(echoWords('v2.28.0')).toEqual(['v', 'two', 'twenty', 'eight', 'zero']);
    expect(echoWords("It's 105")).toEqual(['its', 'one', 'hundred', 'five']);
    expect(echoWords('Out4')).toEqual(['out', 'four']);
  });

  it('gives Whisper-distorted words the same key', () => {
    expect(soundKey('shift')).toBe(soundKey('shipped'));
    expect(soundKey('site')).toBe(soundKey('sight'));
    expect(soundKey('site')).toBe(soundKey('cite'));
    expect(soundKey('go')).not.toBe(soundKey('checks'));
    expect(soundKey('phone')).toBe(soundKey('fone'));
    expect(soundKey('hi')).toBe(soundKey('hey'));
    expect(soundKey('stop')).not.toBe(soundKey('shipped'));
    expect(soundKey('wait')).not.toBe(soundKey('site'));
  });
});

describe('isLikelyEcho: real echoes', () => {
  it.each([
    'Doc Upload Site, shift V2.',
    'Doc Upload',
    'Doc upload site shipped version two',
    'doc upload sight shipped v2 28',
    'supdox.com',
    'The deploy checks passed.',
  ])('%s', (heard) => {
    expect(isLikelyEcho(heard, [SAID])).toBe(true);
  });

  it('greetings echo back', () => {
    expect(isLikelyEcho('Hi.', ["Hi, I'm Herald. Two sessions finished, and one is waiting on you."])).toBe(true);
    expect(isLikelyEcho('Hey, hey.', ['Hey! Nothing new since you last asked.'])).toBe(true);
  });

  it('matches across several recent sentences', () => {
    expect(isLikelyEcho('shift V2 to sup docs', ['Doc Upload Site shipped v2.28.0.', 'It went to supdox.com.'])).toBe(true);
  });
});

describe('isLikelyEcho: the user really talking', () => {
  it.each([
    'stop',
    'Stop.',
    'wait',
    'wait tell Out4 to hold',
    'Wait, tell Out4 to hold off.',
    'hold on',
    'what about the billing session?',
    'tell me more about doc upload site please and what changed',
    'go on',
  ])('%s', (heard) => {
    expect(isLikelyEcho(heard, [SAID])).toBe(false);
  });

  it('a stop command cuts through even when the echo is transcribed with it', () => {
    expect(isLikelyEcho('Doc Upload Site. Stop.', [SAID])).toBe(false);
    expect(isLikelyEcho('wait wait doc upload', [SAID])).toBe(false);
  });

  it('but Herald saying "stop" itself is still echo', () => {
    expect(isLikelyEcho('stop the server', ['I can stop the server if you want.'])).toBe(true);
  });

  it('nothing spoken, or nothing heard: never echo', () => {
    expect(isLikelyEcho('Doc Upload', [])).toBe(false);
    expect(isLikelyEcho('Doc Upload', ['  '])).toBe(false);
    expect(isLikelyEcho('', [SAID])).toBe(false);
    expect(isLikelyEcho('...', [SAID])).toBe(false);
  });

  it('minTokens: short transcripts can be exempted (server backstop)', () => {
    expect(isLikelyEcho('Hi.', ['Hi there.'], { minTokens: 2 })).toBe(false);
    expect(isLikelyEcho('Doc Upload', [SAID], { minTokens: 2 })).toBe(true);
  });

  it('order matters: the same words scrambled are not an echo', () => {
    expect(isLikelyEcho('passed checks deploy site upload doc', [SAID])).toBe(false);
  });
});

describe('echoScore', () => {
  it('reports what did not match', () => {
    const s = echoScore('Doc Upload Site, shift V2, what now?', SAID);
    expect(s.matched).toBe(6);
    expect(s.unmatched).toEqual(['what', 'now']);
  });
});
