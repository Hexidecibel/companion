import { describe, expect, it } from 'vitest';
import { matchShowAgentsCommand } from '../showAgents';
import { matchShowCommand } from '../voiceCommands';

describe('matchShowAgentsCommand', () => {
  it.each([
    'Show me the agents',
    'show me the agents.',
    'Hey Jarvis, show me my agents',
    'open the agents page',
    'show agents',
    'pull up the subagents',
    'show me all the agents please',
    'Herald, show me the agent list',
  ])('matches %s', (t) => expect(matchShowAgentsCommand(t)).toBe(true));

  it.each([
    'show me Out4',
    'how are the agents doing',
    'show me the agents on my phone',
    'what are the agents up to',
    'show me the agent that failed',
    '',
  ])('does not match %s', (t) => expect(matchShowAgentsCommand(t)).toBe(false));

  it('plain session show commands still parse the old way', () => {
    expect(matchShowCommand('show me Out4')).toEqual({ target: 'out4', device: null });
  });
});
