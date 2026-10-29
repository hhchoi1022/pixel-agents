import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeLatest, readEzphotLatest, readNgsfLatest } from '../src/pipelineStatus.js';

const NOW = Date.parse('2026-10-24T00:00:00Z');

let root: string;
const write = (rel: string, body: string, mtimeMs?: number) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtimeMs !== undefined) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-status-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readEzphotLatest', () => {
  const CSV = 'path,telname,success,step\n/a.fits,7DT01,True,done\n/b.fits,7DT02,False,wcs\n';

  it('picks the newest run across objects and counts the csv', () => {
    write('log/OLD/process_images_a.csv', CSV, NOW - 3_600_000);
    write('log/T1/process_images_b.log', '[process_images] 2/2 images succeeded in 71s\n', NOW);
    write('log/T1/process_images_b.csv', CSV, NOW);
    write('viz/ezphot/T1/viz/index.html', '');
    const r = readEzphotLatest([], path.join(root, 'log'), path.join(root, 'viz'));
    expect(r).toMatchObject({
      objname: 'T1',
      tag: 'b',
      state: 'done',
      nImages: 2,
      nSucceeded: 1, // the csv wins over the log line
      seconds: 71,
      gallery: true,
    });
  });

  it('is running while a live process_images writes that csv', () => {
    write('log/T1/process_images_c.log', '', NOW);
    const r = readEzphotLatest(
      [
        {
          argv: [
            'python',
            '-m',
            'ezphot.recipes.process_images',
            '--paths',
            'x',
            'y',
            '--out',
            'process_images_c.csv',
          ],
          cwd: path.join(root, 'log/T1'),
        },
      ],
      path.join(root, 'log'),
      path.join(root, 'viz'),
    );
    expect(r).toMatchObject({ state: 'running', nImages: 2, gallery: false });
  });

  it('is stopped with only a log left, and null with no runs', () => {
    write('log/T1/process_images_d.log', '[process_images] 4 images\n', NOW);
    expect(readEzphotLatest([], path.join(root, 'log'))).toMatchObject({
      state: 'stopped',
      nImages: 4,
    });
    expect(readEzphotLatest([], path.join(root, 'missing'))).toBeNull();
  });
});

describe('readNgsfLatest', () => {
  const FIT =
    'SPECTRUM,SN_TYPE,SN_SUBTYPE,Z,CHI2/dof2\n' +
    'x.ascii,Ia,Ia-norm,0.013,1.0\n' +
    'x.ascii,Ia,Ia-91T,0.014,1.2\n' +
    'x.ascii,II,IIP,0.02,2.5\n';

  it('reads top-1, margin to the next type, QA and verdict', () => {
    write('runs/SN1/SN1_epoch0.fit', FIT, NOW - 60_000);
    write('runs/OLD/OLD_epoch0.fit', FIT, NOW - 3_600_000);
    write('runs/SN1/SN1_epoch0_qa.json', JSON.stringify({ overall: 'WARN' }), NOW);
    write('runs/SN1/SN1_epoch0_qa_verdict.txt', 'Verdict: accept\nbecause', NOW);
    const r = readNgsfLatest([], path.join(root, 'runs'), NOW);
    expect(r).toMatchObject({
      objname: 'SN1',
      stem: 'SN1_epoch0',
      state: 'done',
      type: 'Ia',
      subtype: 'Ia-norm',
      z: 0.013,
      nextType: 'II',
      secure: true,
      qa: 'WARN',
      verdict: 'accept',
    });
    expect(r?.margin).toBeCloseTo(1.5);
  });

  it('prefers a fit in progress over newer finished ones', () => {
    write('runs/DONE/DONE_epoch0.fit', FIT, NOW);
    const busy = write('runs/BUSY/BUSY_epoch1.ascii', '', NOW - 3_600_000);
    const r = readNgsfLatest(
      [{ argv: ['/env/bin/ngsf7dt-fit', busy], cwd: '/' }],
      path.join(root, 'runs'),
      NOW,
    );
    expect(r).toMatchObject({ objname: 'BUSY', stem: 'BUSY_epoch1', state: 'running', type: null });
  });
});

describe('readBridgeLatest', () => {
  it('reports the newest target, its stages and classification', () => {
    write('results/OLD/OLD_visibility.png', '');
    fs.utimesSync(
      path.join(root, 'results/OLD'),
      (NOW - 30 * 86_400_000) / 1000,
      (NOW - 30 * 86_400_000) / 1000,
    );
    write('results/SN1/SN1_visibility.png', '');
    write('results/SN1/SN1_20260307_020651_ezphot_forced_LC.dat', '');
    write(
      'results/SN1/SN1_20260307_020651_tract7dt_CL_summary.ascii_fixed_width',
      '| objname | classification | sn_type | redshift |\n| SN1 | Ia-91T | Ia | 0.123 |\n',
    );
    fs.utimesSync(path.join(root, 'results/SN1'), NOW / 1000, NOW / 1000);
    const r = readBridgeLatest(path.join(root, 'results'), NOW);
    expect(r).toMatchObject({
      target: 'SN1',
      stages: { visibility: true, photometry: true, lightcurve: true, classification: true },
      classification: { label: 'Ia-91T', type: 'Ia', redshift: 0.123, source: 'tract7dt' },
      recentCount: 1,
    });
  });

  it('a target with only its visibility plot is waiting for observation', () => {
    write('results/AT1/AT1_visibility.png', '');
    expect(readBridgeLatest(path.join(root, 'results'), Date.now())).toMatchObject({
      target: 'AT1',
      stages: { visibility: true, photometry: false, lightcurve: false, classification: false },
      classification: null,
    });
  });
});
