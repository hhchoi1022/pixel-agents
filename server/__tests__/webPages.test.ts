import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { WebPageRow } from '../src/webPages.js';
import {
  mergeWebPages,
  parsePortsTable,
  parseProcNetTcp,
  probePort,
  projectForCwd,
  scanListeners,
} from '../src/webPages.js';

const HEADER = `# 포트 기록

| 포트 | 담당 | 용도 | URL | 서빙 디렉토리 | 상태 |
|---|---|---|---|---|---|
`;

describe('parsePortsTable', () => {
  it('reads table rows and skips headers, prose and broken rows', () => {
    const rows = parsePortsTable(
      HEADER +
        '| 8765 | ezphot-developer / ezphot-viz | 처리 현황 (`/ezphot/`) | `http://127.0.0.1:8765/ezphot/` · `http://127.0.0.1:8765/ezphot/<objname>/viz/` | `/home/x/viz` | 상시 |\n' +
        '| abc | not a row | | | | |\n' +
        '| 8770 | bridge |\n' + // too few columns
        'some prose | 8771 | not at line start\n' +
        '| 8772 | ngsf-qa | old report | `http://127.0.0.1:8772/` | | 종료 (2026-10-20) |\n',
    );
    expect(rows.map((r) => r.port)).toEqual([8765, 8772]);
    const [ez, old] = rows;
    expect(ez.agents).toEqual(['ezphot-developer', 'ezphot-viz']);
    expect(ez.purpose).toBe('처리 현황 (/ezphot/)');
    expect(ez.servingDir).toBe('/home/x/viz');
    expect(ez.state).toBe('permanent');
    // The template's parent path is already listed: one link, annotated.
    expect(ez.links).toEqual([
      {
        href: 'http://127.0.0.1:8765/ezphot/',
        template: 'http://127.0.0.1:8765/ezphot/<objname>/viz/',
      },
    ]);
    expect(old.state).toBe('stopped');
    expect(old.statusText).toBe('종료 (2026-10-20)');
  });

  it('tolerates missing trailing columns', () => {
    const [row] = parsePortsTable(
      '| 8775 | bridge_developer | 임시 | `http://127.0.0.1:8775/` |\n',
    );
    expect(row.port).toBe(8775);
    expect(row.state).toBe('other');
    expect(row.links).toEqual([{ href: 'http://127.0.0.1:8775/', template: null }]);
  });
});

describe('probePort', () => {
  it('reports a listening port live and a closed one dead', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probePort(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probePort(port)).toBe(false);
  });
});

// Two LISTEN sockets in the band (one IPv4 8765, one 8770), one outside it
// (22), and an established connection on 8766 that is not a listener.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0
   2: 0100007F:223E 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0
   3: 0100007F:2242 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0
`;

describe('parseProcNetTcp', () => {
  it('keeps only LISTEN sockets inside the band', () => {
    expect([...parseProcNetTcp(TCP, 8760, 8780)]).toEqual([
      [8765, ['111']],
      [8770, ['444']],
    ]);
  });
});

describe('scanListeners', () => {
  it('names the lowest PID holding each listening socket', () => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-proc-'));
    fs.mkdirSync(path.join(proc, 'net'));
    fs.writeFileSync(path.join(proc, 'net', 'tcp'), TCP);
    const fakeProcess = (pid: number, inode: string, cwd: string, argv: string[]) => {
      const dir = path.join(proc, String(pid));
      fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
      fs.symlinkSync(`socket:[${inode}]`, path.join(dir, 'fd', '3'));
      fs.symlinkSync(cwd, path.join(dir, 'cwd'));
      fs.writeFileSync(path.join(dir, 'cmdline'), argv.join('\0') + '\0');
    };
    fakeProcess(500, '111', '/srv/viz', ['python3', '-m', 'http.server', '8765']);
    fakeProcess(900, '111', '/srv/viz', ['python3', 'worker']); // forked child
    fakeProcess(700, '444', '/repo/sub', ['node', 'serve.js']);

    expect(scanListeners(8760, 8780, proc)).toEqual([
      { port: 8765, pid: 500, cwd: '/srv/viz', command: 'python3 -m http.server 8765' },
      { port: 8770, pid: 700, cwd: '/repo/sub', command: 'node serve.js' },
    ]);
    fs.rmSync(proc, { recursive: true, force: true });
  });

  it('finds nothing without /proc', () => {
    expect(scanListeners(8760, 8780, '/nonexistent-proc')).toEqual([]);
  });
});

describe('projectForCwd', () => {
  it('matches a cwd at or under a project root, not a sibling prefix', () => {
    const projects = [{ name: 'ezphot', path: '/code/ezphot' }];
    expect(projectForCwd('/code/ezphot/web', projects)).toBe('ezphot');
    expect(projectForCwd('/code/ezphot', projects)).toBe('ezphot');
    expect(projectForCwd('/code/ezphot2', projects)).toBeNull();
  });
});

describe('mergeWebPages', () => {
  const row = (port: number, servingDir: string): WebPageRow => ({
    port,
    agents: ['ezphot'],
    purpose: 'p',
    links: [],
    servingDir,
    state: 'permanent',
    statusText: '상시',
  });

  it('fills registered rows from the scan and adds unregistered listeners as one-offs', () => {
    const pages = mergeWebPages(
      [row(8765, '/srv/viz'), row(8766, '/srv/ngsf/'), row(8767, '/srv/ops')],
      [
        { port: 8765, pid: 500, cwd: '/srv/viz', command: 'python3 -m http.server' },
        { port: 8766, pid: 600, cwd: '/tmp', command: 'python3 -m http.server' },
        { port: 8771, pid: 700, cwd: '/code/BRIDGE/out', command: 'node serve.js' },
      ],
      new Set(),
      (cwd) => (cwd.startsWith('/code/BRIDGE') ? 'BRIDGE' : null),
    );
    expect(pages.map((p) => [p.port, p.live, p.pid, p.state, p.foreignHolder])).toEqual([
      [8765, true, '500', 'permanent', false],
      // Held by a process that isn't serving the registered directory.
      [8766, true, '600', 'permanent', true],
      [8767, false, '', 'permanent', false],
      [8771, true, '700', 'oneoff', false],
    ]);
    const oneOff = pages[3];
    expect(oneOff.agents).toEqual(['BRIDGE']);
    expect(oneOff.statusText).toBe('일회성');
    expect(oneOff.cwd).toBe('/code/BRIDGE/out');
    expect(oneOff.command).toBe('node serve.js');
    expect(oneOff.links).toEqual([{ href: 'http://127.0.0.1:8771/', template: null }]);
  });

  it('accepts a serving directory named on the command line, and a probe the scan missed', () => {
    const [named, probed] = mergeWebPages(
      [row(8765, '/srv/viz'), row(8767, '/srv/ops')],
      [{ port: 8765, pid: 5, cwd: '/', command: 'python3 -m http.server -d /srv/viz' }],
      new Set([8767]),
      () => null,
    );
    expect(named.foreignHolder).toBe(false);
    expect(probed.live).toBe(true);
    expect(probed.pid).toBe('');
  });

  it("accepts a holder running from the owning project's Directory", () => {
    const [app] = mergeWebPages(
      [row(8767, '/srv/ops')],
      [{ port: 8767, pid: 9, cwd: '/code/ezphot/monitor', command: 'python -u run.py' }],
      new Set(),
      (cwd) => (cwd.startsWith('/code/ezphot') ? 'EZPHOT' : null),
    );
    expect(app.foreignHolder).toBe(false);
  });

  it('flags nothing on a port with no visible holder', () => {
    const [unseen] = mergeWebPages(
      [row(8765, '/srv/viz')],
      [{ port: 8765, pid: null, cwd: null, command: null }],
      new Set(),
      () => null,
    );
    expect(unseen.live).toBe(true);
    expect(unseen.foreignHolder).toBe(false);
    expect(unseen.pid).toBe('');
  });
});
