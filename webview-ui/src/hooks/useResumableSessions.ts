import { useEffect, useState } from 'react';

import type { ResumableSession } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

/**
 * The sessions the launch drawer can resume, asked for each time the resume
 * list opens (`requestResumableSessions`) so a session closed a moment ago is
 * in it. null while the answer is on its way. The reply is point-to-point and
 * feeds this one list, so it is read straight off the transport rather than
 * through the office-wide message hook.
 */
export function useResumableSessions(active: boolean): ResumableSession[] | null {
  const [sessions, setSessions] = useState<ResumableSession[] | null>(null);

  useEffect(() => {
    if (!active) return;
    setSessions(null);
    const unsubscribe = transport.onMessage((msg) => {
      if (msg.type === 'resumableSessions') setSessions(msg.sessions);
    });
    transport.send({ type: 'requestResumableSessions' });
    return unsubscribe;
  }, [active]);

  return sessions;
}
