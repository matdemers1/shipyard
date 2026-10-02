/**
 * SHP-T-9.2: the story panel's picture — a deploy as Shipyard runs it (SHP-REQ-012), the same six
 * steps in the same order the engine runs them (packages/sequence/src/machine.ts: backup → migrate →
 * pull → swap → check → soak), and the image-only roll back from a failed soak to the release that
 * was running (SHP-REQ-016). Decorative: the headline and claims beside it say it in words.
 *
 * Tokens only, through classes in entry.css. Arrives once per page load; not at all under
 * prefers-reduced-motion.
 */
export const DEPLOY_STEPS = ['backup', 'migrate', 'pull', 'swap', 'check', 'soak'] as const;

const TOP = 20;
const ROW = 36;
const NODE_X = 28;
const rowY = (i: number): number => TOP + i * ROW;

export function DeployIllustration({ className }: { className?: string }) {
  const last = DEPLOY_STEPS.length - 1;
  const swapY = rowY(DEPLOY_STEPS.indexOf('swap'));
  const soakY = rowY(last);
  return (
    <svg
      viewBox="0 0 300 232"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path className="shp-entry-art__spine" d={`M${NODE_X} ${TOP} V${soakY}`} />

      {DEPLOY_STEPS.map((step, i) => {
        const y = rowY(i);
        const lit = i === last;
        return (
          <g key={step} className="shp-entry-art__step" style={{ ['--shp-entry-i' as string]: i }}>
            <circle
              className={lit ? 'shp-entry-art__node shp-entry-art__node--lit' : 'shp-entry-art__node'}
              cx={NODE_X}
              cy={y}
              r="9"
            />
            {lit ? (
              <circle className="shp-entry-art__pulse" cx={NODE_X} cy={y} r="3.5" />
            ) : (
              <path className="shp-entry-art__tick" d={`M${NODE_X - 4} ${y} l3 3 l5 -6`} />
            )}
            <text className="shp-entry-art__label" x="50" y={y + 4.5}>
              {step}
            </text>
          </g>
        );
      })}

      <g className="shp-entry-art__back">
        <path
          className="shp-entry-art__arc"
          d={`M112 ${soakY} C196 ${soakY} 196 ${swapY} 112 ${swapY}`}
        />
        <path className="shp-entry-art__head" d={`M120 ${swapY - 5} L112 ${swapY} L120 ${swapY + 5}`} />
        <text className="shp-entry-art__label shp-entry-art__label--faint" x="196" y={(soakY + swapY) / 2 + 4.5}>
          roll back
        </text>
      </g>
    </svg>
  );
}
