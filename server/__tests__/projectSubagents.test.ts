import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readProjectSubagents, subagentNameOf } from '../src/projectSubagents.js';

describe('subagentNameOf', () => {
  it('reads the frontmatter name, quoted or not', () => {
    expect(subagentNameOf('---\nname: bridge-engineer\nmodel: opus\n---\n# x', 'a.md')).toBe(
      'bridge-engineer',
    );
    expect(subagentNameOf('---\r\nname: "ngsf-qa"\r\n---\r\n', 'a.md')).toBe('ngsf-qa');
  });

  it("falls back to the file's stem without a name", () => {
    expect(subagentNameOf('---\ndescription: x\n---\n', 'ezphot-runner.md')).toBe('ezphot-runner');
    expect(subagentNameOf('# no frontmatter\nname: not-this', 'plain.md')).toBe('plain');
  });
});

describe('readProjectSubagents', () => {
  let project: string;
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-subagents-'));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  const write = (rel: string, body: string) => {
    const file = path.join(project, '.claude', 'agents', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  it('is empty without a definitions folder', () => {
    expect(readProjectSubagents(project)).toEqual([]);
  });

  it('lists top-level definitions in file order, skipping archives and duplicates', () => {
    write('b-reviewer.md', '---\nname: b-reviewer\n---\n');
    write('a-engineer.md', '---\nname: a-engineer\n---\n');
    write('copy.md', '---\nname: a-engineer\n---\n');
    write('_archive/old.md', '---\nname: old\n---\n');
    write('_draft.md', '---\nname: draft\n---\n');
    write('notes.txt', 'name: nope');
    expect(readProjectSubagents(project)).toEqual(['a-engineer', 'b-reviewer']);
  });
});
