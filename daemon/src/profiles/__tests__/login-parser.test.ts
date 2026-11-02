import { isAllowedLoginUrl, parseLoginOutput } from '../login-parser';

const Q = 'code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth&state=xyz';
const FULL = `https://claude.com/cai/oauth/authorize?${Q}`;

const claudeJoined = [
  `hexi@box:~$ sh -c 'trap : INT; claude auth login; echo $? > "$0"' '/home/h/.companion/profile-login/a.exit'`,
  'Opening browser to sign in…',
  `If the browser didn't open, visit: ${FULL}`,
  'Paste code here if prompted > ',
  '',
  '',
].join('\n');

const codexBlock = [
  '',
  'Welcome to Codex [v0.165.0]',
  "OpenAI's command-line coding agent",
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   https://auth.openai.com/codex/device',
  '',
  '2. Enter this one-time code (expires in 15 minutes)',
  '   ABCD-EFGH2',
  '',
  'Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.',
  '',
].join('\n');

describe('parseLoginOutput', () => {
  it('Claude: link + prompt from the joined capture', () => {
    expect(parseLoginOutput('claude', claudeJoined)).toEqual({
      url: FULL,
      blockedLink: false,
      codePrompt: true,
      codePromptEmpty: true,
    });
  });

  it('Claude: a link hard-wrapped at 80 columns is put back together', () => {
    const line = `If the browser didn't open, visit: ${FULL}`;
    const hard = [];
    for (let i = 0; i < line.length; i += 80) hard.push(line.slice(i, i + 80));
    const pane = ['Opening browser to sign in…', ...hard, 'Paste code here if prompted > '].join('\n');
    expect(parseLoginOutput('claude', pane).url).toBe(FULL);
  });

  it('Claude: a typed code means the prompt is no longer empty', () => {
    const r = parseLoginOutput('claude', claudeJoined.replace('prompted > ', 'prompted > abc#def'));
    expect(r.codePrompt).toBe(true);
    expect(r.codePromptEmpty).toBe(false);
  });

  it('Codex: link and device code, not joined with the next text', () => {
    const r = parseLoginOutput('codex', codexBlock);
    expect(r.url).toBe('https://auth.openai.com/codex/device');
    expect(r.deviceCode).toBe('ABCD-EFGH2');
    expect(r.codePrompt).toBe(false);
  });

  it('Codex: other code shapes are read too', () => {
    for (const code of ['WXYZ-1234', 'ABC-DEF-GHI', 'A1B2C3D4']) {
      expect(parseLoginOutput('codex', codexBlock.replace('ABCD-EFGH2', code)).deviceCode).toBe(code);
    }
  });

  it('unknown output reads as nothing', () => {
    expect(parseLoginOutput('claude', 'command not found\n$ ')).toEqual({
      blockedLink: false,
      codePrompt: false,
      codePromptEmpty: false,
    });
    const r = parseLoginOutput('codex', 'Something changed in this version\nnothing else here');
    expect(r.url).toBeUndefined();
    expect(r.deviceCode).toBeUndefined();
  });

  it('a link on another host is reported, never returned', () => {
    const pane = claudeJoined.replace(FULL, 'https://evil.example.com/claude.com/login');
    const r = parseLoginOutput('claude', pane);
    expect(r.url).toBeUndefined();
    expect(r.blockedLink).toBe(true);
  });

  it('an allowed link wins over an unrelated one', () => {
    const pane = `see https://example.com/docs\nvisit: ${FULL}\n`;
    const r = parseLoginOutput('claude', pane);
    expect(r.url).toBe(FULL);
    expect(r.blockedLink).toBe(false);
  });
});

describe('isAllowedLoginUrl', () => {
  it.each([
    ['https://claude.ai/oauth', true],
    ['https://console.anthropic.com/x', true],
    ['https://auth.openai.com/codex/device', true],
    ['https://chatgpt.com/auth', true],
    ['http://claude.com/x', false],
    ['https://claude.com.evil.io/x', false],
    ['https://notclaude.com/x', false],
    ['https://claude.com@evil.io/x', false],
    ['https://user:pw@claude.com/x', false],
    ['https://claude.com:8443/x', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s -> %s', (url, want) => {
    expect(isAllowedLoginUrl(url)).toBe(want);
  });
});
