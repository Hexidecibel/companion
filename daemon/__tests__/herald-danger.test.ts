import { classifyAction, ClassifyInput, findSelectedOption, stricterTier } from '../src/herald/danger';

const base: ClassifyInput = {
  userText: '',
  payload: '',
  pendingQuestion: null,
  pendingOptions: null,
  sessionName: 'companion',
  project: '/home/hexi/local/src/companion',
};

function tier(overrides: Partial<ClassifyInput>) {
  return classifyAction({ ...base, ...overrides });
}

describe('classifyAction', () => {
  describe('plain answers are echo', () => {
    const cases: Array<[string, Partial<ClassifyInput>]> = [
      ['yes', { userText: 'yes', payload: 'yes' }],
      ['option 2 to a benign question', { userText: 'option 2', payload: 'Use a Map', pendingQuestion: 'Which data structure should I use?', pendingOptions: [{ label: 'Use an array' }, { label: 'Use a Map' }] }],
      ['continue', { userText: 'tell it to continue', payload: 'continue' }],
      ['go ahead skip tests', { userText: 'go ahead but skip tests', payload: 'Go ahead, but skip the tests for now.' }],
      ['benign question yeah', { userText: 'yeah', payload: 'yes', pendingQuestion: 'Should I refactor the parser into two files?' }],
      ['looks good', { userText: 'looks good, keep going', payload: 'Looks good, keep going.' }],
    ];
    it.each(cases)('%s', (_name, input) => {
      const r = tier(input);
      expect(r.tier).toBe('echo');
      expect(r.reasons).toEqual([]);
    });
  });

  describe('dangerous requests hard-confirm', () => {
    const cases: Array<[string, string]> = [
      ['deploy', 'deploy it'],
      ['release', 'cut a release'],
      ['publish', 'publish the package'],
      ['push', 'push to origin'],
      ['git push', 'run git push'],
      ['force push', 'force push the branch'],
      ['--force flag', 'use --force'],
      ['delete', 'delete the old logs'],
      ['remove', 'remove that file'],
      ['rm', 'just rm it'],
      ['drop table', 'drop the users table'],
      ['wipe', 'wipe the cache dir'],
      ['reset', 'reset the branch'],
      ['destroy', 'destroy the environment'],
      ['truncate', 'truncate the table'],
      ['migrate', 'run the migration'],
      ['restart daemon', 'restart the companion daemon'],
      ['stop', 'stop the service'],
      ['kill', 'kill the process'],
      ['prod', 'ship it to prod'],
      ['production', 'point it at production'],
      ['AJ box', "copy it to AJ's box"],
      ['mac mini', 'rsync to the mac mini'],
      ['secrets', 'rotate the secrets'],
      ['api key', 'paste the api key into config'],
      ['.env', 'edit the .env file'],
      ['no-verify', 'commit with --no-verify'],
      ['skip hooks', 'skip the pre-commit hooks'],
      ['irreversible', 'do it even though it is irreversible'],
      ['negated still dangerous', "don't deploy yet"],
      ['sudo', 'run it with sudo'],
    ];
    it.each(cases)('%s', (_name, text) => {
      const r = tier({ userText: text, payload: text });
      expect(r.tier).toBe('hard_confirm');
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.reasons[0]).toMatch(/your request involves/);
    });
  });

  describe('danger in the pending question escalates a casual answer', () => {
    it('yeah to a prod deploy question', () => {
      const r = tier({ userText: 'yeah', payload: 'yes', pendingQuestion: 'Ready to deploy to prod?' });
      expect(r.tier).toBe('hard_confirm');
      expect(r.reasons.some((x) => x.startsWith("the session's question involves"))).toBe(true);
    });
    it('option pick where the selected option is dangerous', () => {
      const r = tier({
        userText: 'option 1',
        payload: 'Force push',
        pendingQuestion: 'How should I update the remote?',
        pendingOptions: [{ label: 'Force push' }, { label: 'Open a PR' }],
      });
      expect(r.tier).toBe('hard_confirm');
    });
    it('dangerous text only in an unselected option does not escalate', () => {
      const r = tier({
        userText: 'option 2',
        payload: 'Open a PR',
        pendingQuestion: 'How should I update the remote branch?',
        pendingOptions: [{ label: 'Rebase and force' }, { label: 'Open a PR' }],
      });
      expect(r.tier).toBe('echo');
    });
    it('selected option description is scanned', () => {
      const r = tier({
        userText: '2',
        payload: 'Clean up',
        pendingQuestion: 'What next?',
        pendingOptions: [{ label: 'Keep' }, { label: 'Clean up', description: 'Deletes the build artifacts' }],
      });
      expect(r.tier).toBe('hard_confirm');
    });
    it('permission prompt for a destructive command', () => {
      const r = tier({ userText: 'approve it', payload: 'yes', pendingQuestion: 'approve Bash: rm -rf dist' });
      expect(r.tier).toBe('hard_confirm');
    });
  });

  describe('sensitive targets', () => {
    it('session named prod', () => {
      expect(tier({ userText: 'yes', payload: 'yes', sessionName: 'prod-db' }).tier).toBe('hard_confirm');
    });
    it('project on a deploy repo', () => {
      expect(tier({ userText: 'yes', payload: 'yes', project: '/srv/deploy-scripts' }).tier).toBe('hard_confirm');
    });
    it('plain project is fine', () => {
      expect(tier({ userText: 'yes', payload: 'yes', project: '/home/hexi/src/notes' }).tier).toBe('echo');
    });
  });

  describe('batches and model escalation', () => {
    it('a batch member is classified on its own merits (safe member stays echo)', () => {
      const r = tier({ userText: 'tell them all go ahead', payload: 'go ahead', sessionName: 'docs' });
      expect(r.tier).toBe('echo');
      expect(r.reasons).toEqual([]);
    });
    it('a dangerous batch member is split out to hard_confirm', () => {
      const r = tier({ userText: 'tell them all go ahead', payload: 'go ahead', pendingQuestion: 'Push to origin main?' });
      expect(r.tier).toBe('hard_confirm');
    });
    it('model may escalate', () => {
      expect(tier({ userText: 'yes', payload: 'yes', requestedConfirm: true }).tier).toBe('hard_confirm');
    });
    it('model cannot lower (requestedConfirm false keeps danger)', () => {
      expect(tier({ userText: 'deploy', payload: 'deploy', requestedConfirm: false }).tier).toBe('hard_confirm');
    });
  });

  describe('no false positives on substrings', () => {
    const cases = ['use the pusher library', 'add a tokenizer test', 'format the markdown', 'rename the variable', 'the stopwatch component'];
    it.each(cases)('%s', (text) => {
      expect(tier({ userText: text, payload: text }).tier).toBe('echo');
    });
  });

  it('reasons are de-duplicated', () => {
    const r = tier({ userText: 'deploy deploy', payload: 'deploy now' });
    const dup = r.reasons.filter((x) => x === 'your request involves: deploy');
    expect(dup).toHaveLength(1);
  });
});

describe('findSelectedOption', () => {
  const opts = [{ label: 'Yes' }, { label: 'No' }, { label: 'Maybe later' }];
  it.each([
    ['Yes', 'Yes'],
    ['no', 'No'],
    ['2', 'No'],
    ['option 3', 'Maybe later'],
    ['#1', 'Yes'],
  ])('%s -> %s', (payload, label) => {
    expect(findSelectedOption(payload, opts)?.label).toBe(label);
  });
  it('out of range', () => expect(findSelectedOption('9', opts)).toBeNull());
  it('no options', () => expect(findSelectedOption('1', null)).toBeNull());
});

describe('stricterTier', () => {
  it('never lowers', () => {
    expect(stricterTier('hard_confirm', 'echo')).toBe('hard_confirm');
    expect(stricterTier('echo', 'hard_confirm')).toBe('hard_confirm');
    expect(stricterTier('echo', 'echo')).toBe('echo');
  });
});
