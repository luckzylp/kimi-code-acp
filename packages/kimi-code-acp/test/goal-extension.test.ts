import { describe, expect, it } from 'vitest';

import { parseGoalRequest } from '../src/goal-extension';

describe('parseGoalRequest', () => {
  it('accepts set and clear', () => {
    expect(parseGoalRequest({ sessionId: 's1', action: 'set', objective: ' ship it ' })).toEqual({
      sessionId: 's1',
      action: 'set',
      objective: 'ship it',
    });
    expect(parseGoalRequest({ sessionId: 's1', action: 'clear' })).toEqual({
      sessionId: 's1',
      action: 'clear',
    });
  });

  it('rejects malformed requests', () => {
    expect(() => parseGoalRequest(null)).toThrow();
    expect(() => parseGoalRequest({ action: 'set', objective: 'x' })).toThrow();
    expect(() => parseGoalRequest({ sessionId: 's1', action: 'set', objective: '   ' })).toThrow();
    expect(() => parseGoalRequest({ sessionId: 's1', action: 'toggle' })).toThrow();
  });
});
