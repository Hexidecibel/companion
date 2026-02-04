import { extractTasks } from '../parser';

describe('extractTasks', () => {
  const mockJsonlWithTasks = `
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01","name":"TaskCreate","input":{"subject":"Fix login bug","description":"The login button doesn't work on mobile","activeForm":"Fixing login bug"}}]},"timestamp":"2026-01-28T10:00:00.000Z","uuid":"msg1"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"Task created with ID: 1"}]},"timestamp":"2026-01-28T10:00:01.000Z","uuid":"msg2"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_02","name":"TaskCreate","input":{"subject":"Add tests","description":"Write unit tests for auth module"}}]},"timestamp":"2026-01-28T10:00:02.000Z","uuid":"msg3"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"Task created with ID: 2"}]},"timestamp":"2026-01-28T10:00:03.000Z","uuid":"msg4"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_03","name":"TaskUpdate","input":{"taskId":"1","status":"in_progress","activeForm":"Working on login fix"}}]},"timestamp":"2026-01-28T10:00:04.000Z","uuid":"msg5"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_03","content":"Task updated"}]},"timestamp":"2026-01-28T10:00:05.000Z","uuid":"msg6"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_04","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]},"timestamp":"2026-01-28T10:00:06.000Z","uuid":"msg7"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_04","content":"Task updated"}]},"timestamp":"2026-01-28T10:00:07.000Z","uuid":"msg8"}
`.trim();

  it('should extract tasks from JSONL content', () => {
    const tasks = extractTasks(mockJsonlWithTasks);

    expect(tasks).toHaveLength(2);
  });

  it('should parse task subject and description', () => {
    const tasks = extractTasks(mockJsonlWithTasks);

    const task1 = tasks.find((t) => t.subject === 'Fix login bug');
    expect(task1).toBeDefined();
    expect(task1?.description).toBe("The login button doesn't work on mobile");
  });

  it('should apply status updates in order', () => {
    const tasks = extractTasks(mockJsonlWithTasks);

    const task1 = tasks.find((t) => t.subject === 'Fix login bug');
    const task2 = tasks.find((t) => t.subject === 'Add tests');

    // Task 1 was updated to completed
    expect(task1?.status).toBe('completed');

    // Task 2 was never updated, should be pending
    expect(task2?.status).toBe('pending');
  });

  it('should track activeForm from latest update', () => {
    const tasks = extractTasks(mockJsonlWithTasks);

    const task1 = tasks.find((t) => t.subject === 'Fix login bug');
    // Last update didn't have activeForm, but previous one did
    // Actually the completed update clears activeForm
    expect(task1?.activeForm).toBeUndefined();
  });

  it('should extract task IDs from tool results', () => {
    const tasks = extractTasks(mockJsonlWithTasks);

    expect(tasks[0].id).toBe('1');
    expect(tasks[1].id).toBe('2');
  });

  it('should return empty array for content without tasks', () => {
    const noTasks = `
{"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]},"timestamp":"2026-01-28T10:00:00.000Z","uuid":"msg1"}
{"type":"user","message":{"content":"Hi"},"timestamp":"2026-01-28T10:00:01.000Z","uuid":"msg2"}
`.trim();

    const tasks = extractTasks(noTasks);
    expect(tasks).toHaveLength(0);
  });

  it('should handle blockedBy relationships', () => {
    const withBlocking = `
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01","name":"TaskCreate","input":{"subject":"Task A","description":"First task"}}]},"timestamp":"2026-01-28T10:00:00.000Z","uuid":"msg1"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"Task created with ID: 1"}]},"timestamp":"2026-01-28T10:00:01.000Z","uuid":"msg2"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_02","name":"TaskCreate","input":{"subject":"Task B","description":"Second task"}}]},"timestamp":"2026-01-28T10:00:02.000Z","uuid":"msg3"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"Task created with ID: 2"}]},"timestamp":"2026-01-28T10:00:03.000Z","uuid":"msg4"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_03","name":"TaskUpdate","input":{"taskId":"2","addBlockedBy":["1"]}}]},"timestamp":"2026-01-28T10:00:04.000Z","uuid":"msg5"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_03","content":"Task updated"}]},"timestamp":"2026-01-28T10:00:05.000Z","uuid":"msg6"}
`.trim();

    const tasks = extractTasks(withBlocking);
    const taskB = tasks.find((t) => t.subject === 'Task B');

    expect(taskB?.blockedBy).toEqual(['1']);
  });

  it('should handle deleted tasks', () => {
    const withDeleted = `
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01","name":"TaskCreate","input":{"subject":"To Delete","description":"This will be deleted"}}]},"timestamp":"2026-01-28T10:00:00.000Z","uuid":"msg1"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"Task created with ID: 1"}]},"timestamp":"2026-01-28T10:00:01.000Z","uuid":"msg2"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_02","name":"TaskUpdate","input":{"taskId":"1","status":"deleted"}}]},"timestamp":"2026-01-28T10:00:02.000Z","uuid":"msg3"}
{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"Task deleted"}]},"timestamp":"2026-01-28T10:00:03.000Z","uuid":"msg4"}
`.trim();

    const tasks = extractTasks(withDeleted);

    // Deleted tasks should not be included
    expect(tasks).toHaveLength(0);
  });
});
