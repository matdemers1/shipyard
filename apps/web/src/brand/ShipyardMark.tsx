// SHP-T-9.1: the Shipyard mark, ported from d3cloud.io's ProductMark (DI-REQ-040), concept
// "Lift-off". Every D3 Cloud product keeps the planisphere's ring; inside it, ink lines with round
// joints and exactly one lit star in the product's own colour. Here a launch arc rises from the lower
// left and the star sits where it leaves the ring.
//
// The ink is currentColor, so the mark takes the text colour in either theme. The star is the only
// colour. public/favicon.svg is the same drawing at icon weight, with the ink fixed per scheme.

export const SHIPYARD_MARK_NAME = 'Shipyard';

// d3-allow: the product's lit star from d3cloud.io (DI-REQ-040) — a brand constant, the same in both themes, not a theme colour
export const SHIPYARD_STAR = '#5EEAD4';

export interface ShipyardMarkProps {
  /** Rendered width and height in px. At 72 and above the lines are drawn finer, as on the site. */
  size?: number;
  /**
   * Set when the word "Shipyard" is written beside the mark, so a screen reader does not read it
   * twice. Left off, the mark stands alone and is announced as an image named "Shipyard".
   */
  decorative?: boolean;
  className?: string;
}

export function ShipyardMark({ size = 20, decorative = false, className }: ShipyardMarkProps) {
  // The site's two weights: heavier at icon sizes, finer at display sizes.
  const display = size >= 72;
  const w = display ? 2.2 : 3.5;
  const joint = display ? 2.6 : 3.4;
  const lit = display ? 4.4 : 5.5;
  const ink = { stroke: 'currentColor', strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': SHIPYARD_MARK_NAME })}
    >
      <circle cx="32" cy="32" r="26" {...ink} />
      <path d="M18 47 Q21 27 45 18" {...ink} />
      <circle cx="18" cy="47" r={joint} fill="currentColor" />
      <circle cx="25.5" cy="29" r={joint} fill="currentColor" />
      <circle cx="45" cy="18" r={lit} style={{ fill: SHIPYARD_STAR }} />
    </svg>
  );
}
