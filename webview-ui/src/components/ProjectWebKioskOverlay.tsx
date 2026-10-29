import { useEffect, useState } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import { projectWebKioskTarget } from '../office/engine/projectWebKiosk.js';
import { overlayProjection } from '../office/projection.js';

/**
 * The link over the open project's web page kiosk: a click opens the page in
 * a new tab. Follows pan/zoom every frame like the other band overlays.
 */

interface ProjectWebKioskOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

export function ProjectWebKioskOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: ProjectWebKioskOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);
  const el = containerRef.current;
  const target = projectWebKioskTarget();
  if (!el || !target) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );
  const left = project.toScreenX(target.x);
  const top = project.toScreenY(target.y);
  return (
    <a
      href={target.href}
      target="_blank"
      rel="noreferrer"
      title={target.title}
      className="absolute cursor-pointer"
      style={{
        left,
        top,
        width: project.toScreenX(target.x + target.w) - left,
        height: project.toScreenY(target.y + target.h) - top,
        zIndex: 45,
      }}
    />
  );
}
