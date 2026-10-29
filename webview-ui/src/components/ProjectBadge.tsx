import { useEffect, useRef, useState } from 'react';

interface ProjectBadgeProps {
  name: string;
  /** Positioning classes — the badge sits beside different chrome per shell. */
  className?: string;
  /** Absolute path of the current project folder (the menu's checked row). */
  currentPath?: string;
  /** Projects the menu offers; null until the host answers. */
  projects?: Array<{ name: string; path: string }> | null;
  /** Running agents per folder; a folder without any shows no count. */
  agentCounts?: Record<string, number>;
  /** Omit to render a plain label (a read-only office can't switch). */
  onOpenMenu?: () => void;
  onSwitch?: (path: string) => void;
}

/**
 * The office's project name, pinned over the top-left of the office. Clicking
 * it opens a menu of the projects (the Directories other than the
 * superagent's); picking one opens it in every office. Running agents keep
 * running, but the office only shows the open project's (App hides the rest);
 * the tab title and this badge follow the switch.
 */
export function ProjectBadge({
  name,
  className = '',
  currentPath,
  projects = null,
  agentCounts = {},
  onOpenMenu,
  onSwitch,
}: ProjectBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const interactive = onOpenMenu !== undefined && onSwitch !== undefined;

  // Close on a press anywhere outside the badge and its menu.
  useEffect(() => {
    if (!isOpen) return;
    const handlePress = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePress);
    return () => document.removeEventListener('pointerdown', handlePress);
  }, [isOpen]);

  if (!interactive) {
    return (
      <div
        className={`pixel-panel shadow-pixel px-12 pb-4 text-lg leading-none whitespace-nowrap select-none pointer-events-none ${className}`}
        data-testid="project-badge"
      >
        {name}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={className}>
      <button
        className="pixel-panel shadow-pixel px-12 pb-4 text-lg leading-none whitespace-nowrap select-none cursor-pointer hover:bg-btn-hover"
        data-testid="project-badge"
        title="Switch project"
        onClick={() => {
          if (!isOpen) onOpenMenu();
          setIsOpen((v) => !v);
        }}
      >
        {name} {isOpen ? '▴' : '▾'}
      </button>
      {isOpen && (
        <div className="absolute top-full left-0 mt-4 z-20 bg-bg border-2 border-border shadow-pixel p-4 min-w-full max-h-[60vh] overflow-y-auto">
          {projects === null ? (
            <div className="py-2 px-12 text-text-muted whitespace-nowrap">Loading…</div>
          ) : projects.length === 0 ? (
            <div className="py-2 px-12 text-text-muted whitespace-nowrap">No projects</div>
          ) : (
            projects.map(({ name: projectName, path }) => {
              const isCurrent = path === currentPath;
              return (
                <button
                  key={path}
                  title={path}
                  className={`block w-full text-left py-2 px-12 bg-transparent border-none rounded-none whitespace-nowrap ${
                    isCurrent ? 'text-accent cursor-default' : 'cursor-pointer hover:bg-btn-bg'
                  }`}
                  onClick={() => {
                    setIsOpen(false);
                    if (!isCurrent) onSwitch(path);
                  }}
                >
                  {isCurrent ? '✓ ' : '  '}
                  {projectName}
                  {agentCounts[path] ? ` (${agentCounts[path]})` : ''}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
