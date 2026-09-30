import { describe, expect, it } from 'vitest';
import { COMMAND_PHRASES, MAX_COMMAND_WORDS, commandCore, matchVoiceCommand, normalizeUtterance, stripWakeWord, type VoiceCommand } from '../voiceCommands';

describe('matchVoiceCommand: the command table', () => {
  const cases: Array<[string, VoiceCommand]> = [
    // STOP
    ['stop', 'stop'], ['Stop.', 'stop'], ['STOP!', 'stop'], ['quiet', 'stop'], ['Shush.', 'stop'],
    ['Shut up.', 'stop'], ['Enough.', 'stop'], ["That's enough.", 'stop'], ['That’s enough', 'stop'],
    ['Okay, stop.', 'stop'], ['Never mind.', 'stop'], ['Cancel.', 'stop'], ['Thanks.', 'stop'],
    ['Got it.', 'stop'], ['Stop, stop, stop.', 'stop'],
    // REPEAT
    ['Repeat.', 'repeat'], ['Repeat that.', 'repeat'], ['Say that again?', 'repeat'], ['What was that?', 'repeat'],
    ['Come again?', 'repeat'], ['Pardon?', 'repeat'], ['Sorry, what?', 'repeat'],
    // SHORTER
    ['Shorter.', 'shorter'], ['Short version.', 'shorter'], ['TL;DR', 'shorter'], ['tldr', 'shorter'],
    ['Too long.', 'shorter'], ['Bottom line?', 'shorter'], ['Summarize.', 'shorter'], ['Sum it up.', 'shorter'],
    ['Give me the gist.', 'shorter'],
    // MORE
    ['Go on.', 'more'], ['Keep going.', 'more'], ['Continue.', 'more'], ['Tell me more.', 'more'],
    ['More.', 'more'], ['And?', 'more'],
    // BRIEF
    ["What's up?", 'brief'], ['Anything for me?', 'brief'], ["What's new?", 'brief'], ['Brief me.', 'brief'],
    ['Catch me up.', 'brief'], ['What did I miss?', 'brief'], ["Hey Jarvis, what's up?", 'brief'],
    ["Herald, what's up?", 'brief'],
    // RATE
    ['Slower.', 'slower'], ['Slow down.', 'slower'], ['Faster.', 'faster'], ['Speed up.', 'faster'],
  ];
  it.each(cases)('%j -> %s', (text, cmd) => {
    expect(matchVoiceCommand(text)).toBe(cmd);
  });

  it('every phrase in the table matches its own command and fits the word limit', () => {
    for (const [cmd, phrases] of Object.entries(COMMAND_PHRASES)) {
      for (const p of phrases) {
        expect(p.split(' ').length).toBeLessThanOrEqual(MAX_COMMAND_WORDS);
        expect(matchVoiceCommand(p)).toBe(cmd);
      }
    }
  });

  it('no phrase belongs to two commands', () => {
    const seen = new Map<string, string>();
    for (const [cmd, phrases] of Object.entries(COMMAND_PHRASES)) {
      for (const p of phrases) {
        expect(seen.get(p) ?? cmd).toBe(cmd);
        seen.set(p, cmd);
      }
    }
  });
});

describe('matchVoiceCommand: addressing and fillers', () => {
  it.each([
    ['Herald, stop.', 'stop'],
    ['Hey Jarvis, stop.', 'stop'],
    ['Jarvis stop', 'stop'],
    ['Harold, repeat that.', 'repeat'],
    ['Stop, Herald.', 'stop'],
    ['Uh, stop.', 'stop'],
    ['Um, please repeat that.', 'repeat'],
    ['Okay, um, go on.', 'more'],
    ['Could you, uh, slow down', null],
    ['Hey Jarvis, shorter please.', 'shorter'],
    ['Just the gist.', 'shorter'],
  ] as Array<[string, VoiceCommand | null]>)('%j -> %s', (text, cmd) => {
    expect(matchVoiceCommand(text)).toBe(cmd);
  });

  it('a bare name, filler or empty transcript is not a command', () => {
    for (const t of ['', '   ', 'Herald.', 'Hey Jarvis.', 'Okay.', 'Um.', 'Uh, okay.', '...']) {
      expect(matchVoiceCommand(t)).toBeNull();
    }
  });
});

describe('matchVoiceCommand: ordinary messages are never commands', () => {
  it.each([
    'stop the build',
    'Stop the deploy session.',
    'Tell Out4 to stop.',
    'repeat the migration',
    'Repeat the migration on staging.',
    'go on with the deploy',
    'Go on with the deploy, Herald.',
    'shorter timeout for the tests',
    'Make the tests timeout shorter.',
    'more tests for the parser',
    'continue the refactor in companion',
    'what was that error in out4',
    'cancel the deploy',
    'Faster builds would be nice.',
    'Slow down the polling interval.',
    'Is the build quiet now?',
    'Thanks, now tell Out4 to ship it.',
    'Summarize the doc upload site session.',
    'Tell me more about the deploy.',
    "What's up with the deploy?",
    'Anything for me from Out4?',
    'What did I miss in the companion session?',
    "What's everyone working on?",
  ])('%j', (text) => {
    expect(matchVoiceCommand(text)).toBeNull();
  });

  it('long utterances are never commands, whatever they contain', () => {
    expect(matchVoiceCommand('stop stop stop stop stop stop please now okay')).toBe('stop');
    expect(matchVoiceCommand('please stop this and that and the other')).toBeNull();
    expect(matchVoiceCommand(`stop ${'x'.repeat(100)}`)).toBeNull();
  });
});

describe('normalisation helpers', () => {
  it('normalizeUtterance lowercases, drops apostrophes and punctuation', () => {
    expect(normalizeUtterance("  That's   ENOUGH!! ")).toBe('thats enough');
    expect(normalizeUtterance('TL;DR')).toBe('tl dr');
  });

  it('commandCore returns null past the word limit', () => {
    expect(commandCore('one two three four five')).toBe('one two three four five');
    expect(commandCore('one two three four five six')).toBeNull();
  });
});

describe('stripWakeWord', () => {
  it('drops a leading "Hey Jarvis" and keeps everything else', () => {
    expect(stripWakeWord('Hey Jarvis, tell Out4 to hold the refunds.')).toBe('Tell Out4 to hold the refunds.');
    expect(stripWakeWord('jarvis what is blocked')).toBe('What is blocked');
    expect(stripWakeWord('Herald, what is blocked?')).toBe('Herald, what is blocked?');
    expect(stripWakeWord('Tell Jarvis nothing')).toBe('Tell Jarvis nothing');
    expect(stripWakeWord('Hey Jarvis.')).toBe('');
  });
});
