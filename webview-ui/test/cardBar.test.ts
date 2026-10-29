import { describe, expect, it } from 'vitest';

import {
  cardVariant,
  mergeOrder,
  reorderByPointer,
  resolveShownAgent,
} from '../src/components/cardBar.js';

describe('cardVariant', () => {
  it('the showing pane wins over the selected character', () => {
    expect(cardVariant(1, { activeId: 1, focusedId: 1 })).toBe('active');
    expect(cardVariant(2, { activeId: 1, focusedId: 2 })).toBe('focused');
    expect(cardVariant(3, { activeId: 1, focusedId: 2 })).toBe('default');
  });
});

describe('mergeOrder', () => {
  it('keeps the saved order, drops closed agents, appends new ones in creation order', () => {
    expect(mergeOrder([3, 1, 9], [1, 2, 3, 4])).toEqual([3, 1, 2, 4]);
  });

  it('is the live order when nothing was saved', () => {
    expect(mergeOrder([], [5, 6])).toEqual([5, 6]);
  });
});

describe('reorderByPointer', () => {
  // Cards 1..4 laid out 100px apart: midpoints 50, 150, 250, 350.
  const mid = (id: number) => (id - 1) * 100 + 50;

  it('inserts before the first other card whose midpoint is right of the finger', () => {
    expect(reorderByPointer([1, 2, 3, 4], 4, mid, 120)).toEqual([1, 4, 2, 3]);
  });

  it('moves the card last when the finger is past every midpoint', () => {
    expect(reorderByPointer([1, 2, 3, 4], 1, mid, 900)).toEqual([2, 3, 4, 1]);
  });

  it('moves the card first when the finger is left of every midpoint', () => {
    expect(reorderByPointer([1, 2, 3, 4], 3, mid, 0)).toEqual([3, 1, 2, 4]);
  });

  it('skips cards that are not laid out', () => {
    const partial = (id: number) => (id === 2 ? null : mid(id));
    expect(reorderByPointer([1, 2, 3], 1, partial, 200)).toEqual([2, 1, 3]);
  });
});

describe('resolveShownAgent', () => {
  it('shows the active agent while it is in view', () => {
    expect(resolveShownAgent(2, [3, 2], [1, 2, 3])).toBe(2);
  });

  it('returns to the agent last shown in the project switched to', () => {
    // Active agent 5 belongs to the project just left; 3 was last shown here.
    expect(resolveShownAgent(5, [5, 3, 1], [1, 2, 3])).toBe(3);
  });

  it('falls back to the first agent in view when none was shown before', () => {
    expect(resolveShownAgent(5, [5, 6], [1, 2])).toBe(1);
    expect(resolveShownAgent(null, [], [])).toBeNull();
  });
});
