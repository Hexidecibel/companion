import { parseUnifiedDiff, parseNumstatZ, unquotePath, clipLines } from '../diff-parse';

describe('parseUnifiedDiff', () => {
  it('rename with edits', () => {
    const d = parseUnifiedDiff(
      ['diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts', 'index 1..2 100644', '--- a/old.ts', '+++ b/new.ts', '@@ -1,2 +1,2 @@ function f() {', ' a', '-b', '+c', ''].join('\n')
    );
    expect(d[0]).toMatchObject({ oldPath: 'old.ts', newPath: 'new.ts', status: 'renamed', additions: 1, deletions: 1, similarity: 90 });
    expect(d[0].hunks[0].section).toBe('function f() {');
  });

  it('pure rename (no ---/+++) and copy', () => {
    const d = parseUnifiedDiff(['diff --git a/a b/b', 'similarity index 100%', 'rename from a', 'rename to b', 'diff --git a/x b/y', 'similarity index 100%', 'copy from x', 'copy to y', ''].join('\n'));
    expect(d[0]).toMatchObject({ oldPath: 'a', newPath: 'b', status: 'renamed' });
    expect(d[1]).toMatchObject({ oldPath: 'x', newPath: 'y', status: 'copied' });
  });

  it('binary, mode change, deletion, new file', () => {
    const d = parseUnifiedDiff(
      [
        'diff --git a/img.png b/img.png',
        'index 1..2 100644',
        'Binary files a/img.png and b/img.png differ',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        'index 1..0',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-x',
        '-y',
        'diff --git a/n.ts b/n.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@ -0,0 +1 @@',
        '+hi',
        '\\ No newline at end of file',
        '',
      ].join('\n')
    );
    expect(d[0]).toMatchObject({ newPath: 'img.png', binary: true, status: 'modified' });
    expect(d[1]).toMatchObject({ newPath: 'run.sh', status: 'mode_changed', oldMode: '100644', newMode: '100755' });
    expect(d[2]).toMatchObject({ oldPath: 'gone.ts', newPath: null, status: 'deleted', deletions: 2 });
    expect(d[3]).toMatchObject({ oldPath: null, newPath: 'n.ts', status: 'added', additions: 1 });
    expect(d[3].hunks[0].lines).toEqual(['+hi', '\\ No newline at end of file']);
    expect(d[3].hunks[0].oldLines).toBe(0);
    expect(d[3].hunks[0].newLines).toBe(1);
  });

  it('CRLF bodies and unicode / quoted paths', () => {
    const d = parseUnifiedDiff(
      ['diff --git "a/sp\\303\\251cial \\"q\\".ts" "b/sp\\303\\251cial \\"q\\".ts"', '--- "a/sp\\303\\251cial \\"q\\".ts"', '+++ "b/sp\\303\\251cial \\"q\\".ts"', '@@ -1 +1 @@', '-a\r', '+b\r', ''].join('\n')
    );
    expect(d[0].newPath).toBe('spécial "q".ts');
    expect(d[0].hunks[0].lines).toEqual(['-a\r', '+b\r']);
    expect(unquotePath('"a\\tb"')).toBe('a\tb');
  });

  it('unquoted path with spaces from header only', () => {
    const d = parseUnifiedDiff(['diff --git a/my file.txt b/my file.txt', 'old mode 100644', 'new mode 100755', ''].join('\n'));
    expect(d[0].newPath).toBe('my file.txt');
  });
});

describe('parseNumstatZ', () => {
  it('normal, binary, rename', () => {
    const z = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0');
    expect(parseNumstatZ(z)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
      { path: 'img.png', additions: null, deletions: null, binary: true },
      { path: 'new.ts', oldPath: 'old.ts', additions: 2, deletions: 0, binary: false },
    ]);
  });
});

describe('clipLines', () => {
  it('clips long lines', () => {
    expect(clipLines(['+' + 'x'.repeat(10), '+ok'], 5)).toEqual({ lines: ['+xxxx', '+ok'], clipped: true });
  });
});
