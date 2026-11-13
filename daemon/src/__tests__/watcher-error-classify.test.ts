import { classifyWatcherError } from '../watcher';

function errno(code: string, syscall?: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, syscall });
}

describe('classifyWatcherError', () => {
  it('treats ENOSPC on a watch syscall as a recoverable watch limit', () => {
    expect(classifyWatcherError(errno('ENOSPC', 'watch'))).toBe('watch-limit');
  });

  it('recognises the "file watchers" message without a syscall', () => {
    expect(
      classifyWatcherError(
        errno('ENOSPC', undefined, 'ENOSPC: System limit for number of file watchers reached')
      )
    ).toBe('watch-limit');
  });

  it('treats EMFILE (too many inotify instances / fds) as a watch limit', () => {
    expect(classifyWatcherError(errno('EMFILE', 'watch'))).toBe('watch-limit');
  });

  it('keeps a real disk-full ENOSPC (write) fatal', () => {
    expect(classifyWatcherError(errno('ENOSPC', 'write', 'ENOSPC: no space left on device'))).toBe(
      'other'
    );
  });

  it('returns other for non-errors', () => {
    expect(classifyWatcherError(undefined)).toBe('other');
    expect(classifyWatcherError('boom')).toBe('other');
    expect(classifyWatcherError(new Error('x'))).toBe('other');
  });
});
