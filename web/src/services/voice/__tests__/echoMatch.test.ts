import { describe, expect, it } from 'vitest';
import { echoScore, echoWords, isClearBargeIn, isLikelyEcho, keysMatch, soundKey, stripEcho } from '../echoMatch';

// Real production sequence (macOS app, speakers): Herald said this, then these
// "user" messages arrived seconds apart.
const SAID = 'Doc Upload Site shipped v2.28.0 to supdox.com. The deploy checks passed.';

describe('echoWords / soundKey', () => {
  it('drops punctuation, splits letters from digits and spells numbers out', () => {
    expect(echoWords('Shift V2.')).toEqual(['shift', 'v', 'two']);
    expect(echoWords('v2.28.0')).toEqual(['v', 'two', 'point', 'twenty', 'eight', 'point', 'zero']);
    expect(echoWords('supdox.com')).toEqual(['supdox', 'dot', 'com']);
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
    expect(keysMatch(soundKey('deploy'), soundKey('deployed'))).toBe(true);
    expect(keysMatch(soundKey('check'), soundKey('checks'))).toBe(true);
    expect(keysMatch(soundKey('stop'), soundKey('site'))).toBe(false);
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

  it('spoken dots and points, and word endings, still match (real E2E partials)', () => {
    const R = 'Doc Upload Site shipped v2.28.0 to supdox.com, and all the deploy checks passed on the first try.';
    expect(isLikelyEcho('Dot com, and all the deployed...', [R])).toBe(true);
    expect(isLikelyEcho('Connect zero to subdocs.com.', [R])).toBe(true);
    expect(isLikelyEcho("Check's passed on the first try.", [R])).toBe(true);
    expect(isLikelyEcho('V2 28.0', [R])).toBe(true);
    expect(isLikelyEcho('Doc Upload Site doc-upload-site, soundtrack.', [R])).toBe(true);
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

describe('stripEcho (a confirmed interruption mixed with the echo)', () => {
  const R = 'Doc Upload Site shipped v2.28.0 to supdox.com, and all the deploy checks passed on the first try.';
  it('keeps the user, cuts runs of Herald', () => {
    // Real E2E transcript: the user's "Wait, tell Out4 to hold" over Herald's voice.
    expect(stripEcho('Tailout4 to Halt. 28.0 to Subdocs.com', [R])).toBe('Tailout4 to Halt.');
    expect(stripEcho('Doc Upload Site shipped. Stop.', [R])).toBe('Stop.');
    expect(stripEcho('The deploy checks, wait, tell out4 to hold', [R])).toBe('wait, tell out4 to hold');
  });
  it('leaves a clean interruption alone, empties pure echo', () => {
    expect(stripEcho('wait tell Out4 to hold', [R])).toBe('wait tell Out4 to hold');
    expect(stripEcho('Doc upload', [R])).toBe('');
    expect(stripEcho('anything else?', [])).toBe('anything else?');
  });
});

describe('isClearBargeIn (partial transcripts while Herald talks)', () => {
  const R = ['Doc Upload Site shipped v2.28.0 to supdox.com, and all the deploy checks passed on the first try.', 'The billing session is still waiting on you to pick an option.'];
  it('Whisper filling in truncated echo, or echoing its vocabulary hints, is not a person (real E2E partials)', () => {
    expect(isClearBargeIn('The billing session is still waiting for a few minutes to get started.', R)).toBe(false);
    expect(isClearBargeIn('tmux, deploy, haiku,', R)).toBe(false);
    expect(isClearBargeIn('Doc Upload Site doc-upload-site, soundtrack.', R)).toBe(false);
  });
  it('an interrupt word, or mostly new words, is', () => {
    expect(isClearBargeIn('Upload Site shipped V2. Wait till I-', R)).toBe(true);
    expect(isClearBargeIn('Stop.', R)).toBe(true);
    expect(isClearBargeIn('what about the release notes for out4', R)).toBe(true);
    expect(isClearBargeIn('Out4?', R)).toBe(false); // one word: wait for the whole utterance
  });
  it('a stray word left after cutting the echo out is dropped', () => {
    expect(stripEcho('The billing session is still waiting on YouTube.', R)).toBe('');
    expect(stripEcho('The billing session is still waiting. Stop.', R)).toBe('Stop.');
  });
});
