import { extractFileChanges } from '../src/parser';

describe('extractFileChanges', () => {
  it('should return empty array for empty content', () => {
    expect(extractFileChanges('')).toEqual([]);
  });

  it('should return empty array for content with no Write/Edit tools', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/src/index.ts' } },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] },
        timestamp: '2024-01-01T00:00:01Z',
      }),
    ].join('\n');

    expect(extractFileChanges(content)).toEqual([]);
  });

  it('should extract Write tool calls', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Write',
              input: { file_path: '/src/new-file.ts', content: 'console.log("hello")' },
            },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'File written' }] },
        timestamp: '2024-01-01T00:00:01Z',
      }),
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/src/new-file.ts');
    expect(changes[0].action).toBe('write');
    expect(changes[0].timestamp).toBeDefined();
  });

  it('should extract Edit tool calls', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Edit',
              input: { file_path: '/src/existing.ts', old_string: 'foo', new_string: 'bar' },
            },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'File edited' }] },
        timestamp: '2024-01-01T00:00:01Z',
      }),
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/src/existing.ts');
    expect(changes[0].action).toBe('edit');
  });

  it('should deduplicate file paths keeping latest timestamp', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: '/src/file.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        timestamp: '2024-01-01T00:00:01Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: '/src/file.ts', old_string: 'b', new_string: 'c' } },
          ],
        },
        timestamp: '2024-01-01T00:01:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] },
        timestamp: '2024-01-01T00:01:01Z',
      }),
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/src/file.ts');
    // Should use the later timestamp
    expect(changes[0].timestamp).toBe(new Date('2024-01-01T00:01:00Z').getTime());
  });

  it('should handle multiple different files', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/src/a.ts', content: 'a' } },
            { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: '/src/b.ts', old_string: 'x', new_string: 'y' } },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' },
          ],
        },
        timestamp: '2024-01-01T00:00:01Z',
      }),
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(2);
    expect(changes.map(c => c.path).sort()).toEqual(['/src/a.ts', '/src/b.ts']);
  });

  it('should only include completed tool calls (with results)', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/src/pending.ts', content: 'x' } },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      // No tool_result for tool-1 — it's still pending
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(0);
  });

  it('should skip tool calls with missing file_path', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Write', input: { content: 'no path' } },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        timestamp: '2024-01-01T00:00:01Z',
      }),
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toEqual([]);
  });

  it('should upgrade action from edit to write when both happen on same file', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: '/src/file.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        timestamp: '2024-01-01T00:00:01Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Write', input: { file_path: '/src/file.ts', content: 'full rewrite' } },
          ],
        },
        timestamp: '2024-01-01T00:01:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] },
        timestamp: '2024-01-01T00:01:01Z',
      }),
    ].join('\n');

    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('write');
  });
});
