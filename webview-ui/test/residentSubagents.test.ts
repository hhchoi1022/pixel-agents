/**
 * Resident sub-agents: the open project's own definitions
 * (`.claude/agents/*.md`) each keep a character in the office. A spawn naming
 * one as its `subagent_type` wakes that character instead of creating a
 * transient Subtask, and the character stays (idle, at its desk) when the
 * spawn ends. These pin the OfficeState half: binding, release, the
 * one-spawn-per-resident rule, project switches, and folding a sub that was
 * spawned while its project was closed.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { MATRIX_EFFECT_DURATION, TileType } from '../src/office/types.js';

function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

const LEAD = 1;
const inProject = () => true;

/** Let every running matrix effect finish (a despawn deletes its character). */
function settle(os: OfficeState): void {
  os.update(MATRIX_EFFECT_DURATION + 0.01);
}

test('each definition gets an idle resident character', () => {
  const os = new OfficeState(floorLayout());
  os.setResidents(['ezphot-engineer', 'ezphot-reviewer'], undefined, inProject);
  const ids = os.residentIds();
  assert.equal(ids.length, 2);
  for (const id of ids) {
    const ch = os.characters.get(id)!;
    assert.equal(ch.isSubagent, true);
    assert.equal(ch.isActive, false, 'waits until a spawn binds it');
    assert.ok(os.isResident(id));
  }
  assert.deepEqual(
    ids.map((id) => os.characters.get(id)!.residentType),
    ['ezphot-engineer', 'ezphot-reviewer'],
  );
  assert.deepEqual(os.getPersistableSeats(), {}, 'residents are never persisted as agents');
});

test('a spawn of a resident type wakes the resident; its end leaves it in place', () => {
  const os = new OfficeState(floorLayout());
  os.setResidents(['ezphot-engineer'], undefined, inProject);
  const [residentId] = os.residentIds();
  const before = os.characters.size;

  const subId = os.addSubagent(LEAD, 'toolu_1', 'ezphot-engineer', true);
  assert.equal(subId, residentId, 'no new character');
  assert.equal(os.characters.size, before);
  assert.equal(os.characters.get(subId)!.isActive, true);
  assert.equal(os.terminalOwnerOf(subId), LEAD, 'clicks reach the spawning lead');

  os.removeSubagent(LEAD, 'toolu_1');
  settle(os);
  const ch = os.characters.get(residentId);
  assert.ok(ch, 'the resident outlives its spawn');
  assert.equal(ch.isActive, false);
  assert.equal(ch.parentAgentId, null);
  assert.equal(os.getSubagentId(LEAD, 'toolu_1'), null);
  assert.equal(os.terminalOwnerOf(residentId), residentId);

  assert.equal(os.addSubagent(LEAD, 'toolu_2', 'ezphot-engineer', true), residentId, 'rebinds');
});

test('a second concurrent spawn of the same type gets an ordinary sub-agent', () => {
  const os = new OfficeState(floorLayout());
  os.setResidents(['ezphot-runner'], undefined, inProject);
  const [residentId] = os.residentIds();
  assert.equal(os.addSubagent(LEAD, 'toolu_1', 'ezphot-runner', true), residentId);
  const second = os.addSubagent(LEAD, 'toolu_2', 'ezphot-runner', true);
  assert.notEqual(second, residentId);
  assert.equal(os.isResident(second), false);
});

test('spawns from outside the open project, or of other types, stay ordinary', () => {
  const os = new OfficeState(floorLayout());
  os.setResidents(['ezphot-runner'], undefined, inProject);
  const [residentId] = os.residentIds();
  assert.notEqual(os.addSubagent(LEAD, 'toolu_1', 'ezphot-runner', false), residentId);
  assert.notEqual(os.addSubagent(LEAD, 'toolu_2', 'general-purpose', true), residentId);
  assert.notEqual(os.addSubagent(LEAD, 'toolu_3'), residentId);
});

test("closing the parent's agent releases its residents instead of removing them", () => {
  const os = new OfficeState(floorLayout());
  os.setResidents(['bridge-engineer'], undefined, inProject);
  const [residentId] = os.residentIds();
  os.addSubagent(LEAD, 'toolu_1', 'bridge-engineer', true);
  os.removeAllSubagents(LEAD);
  settle(os);
  assert.ok(os.characters.has(residentId));
  assert.equal(os.getSubagentId(LEAD, 'toolu_1'), null);
});

test('switching projects: idle residents leave, a busy one finishes as an ordinary sub', () => {
  const os = new OfficeState(floorLayout());
  os.setResidents(['ezphot-engineer', 'ezphot-reviewer'], undefined, inProject);
  const [busyId, idleId] = os.residentIds();
  os.addSubagent(LEAD, 'toolu_1', 'ezphot-engineer', true);

  os.setResidents(['bridge-engineer'], undefined, inProject);
  settle(os);
  assert.equal(os.characters.has(idleId), false, 'idle resident despawned');
  const busy = os.characters.get(busyId);
  assert.ok(busy, 'busy resident keeps working');
  assert.equal(busy.residentType, undefined, 'no longer a resident');
  assert.equal(os.residentIds().length, 1);

  os.removeSubagent(LEAD, 'toolu_1');
  settle(os);
  assert.equal(os.characters.has(busyId), false, 'goes with its spawn');
});

test('a live sub of a resident type spawned while its project was closed is folded in', () => {
  const os = new OfficeState(floorLayout());
  const transient = os.addSubagent(LEAD, 'toolu_1', 'ngsf-runner', false);
  const swaps = os.setResidents(['ngsf-runner', 'ngsf-qa'], undefined, (id) => id === LEAD);
  const residentId = os.residentIds()[0];
  assert.deepEqual(swaps, [{ from: transient, to: residentId }]);
  assert.equal(os.characters.has(transient), false, 'no duplicate left behind');
  assert.equal(os.getSubagentId(LEAD, 'toolu_1'), residentId);
  assert.equal(os.characters.get(residentId)!.isActive, true);
});

test('a sub of another project is not folded in', () => {
  const os = new OfficeState(floorLayout());
  const transient = os.addSubagent(LEAD, 'toolu_1', 'ngsf-runner', false);
  const swaps = os.setResidents(['ngsf-runner'], undefined, () => false);
  assert.deepEqual(swaps, []);
  assert.ok(os.characters.has(transient));
});
