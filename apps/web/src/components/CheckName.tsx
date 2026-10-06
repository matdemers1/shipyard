import type { CSSProperties } from 'react';
import { checkName } from '../lib/words';

/**
 * A deploy check named by its human name, with its gate code as secondary text (SHP-REQ-171): the
 * dry-run sheet and the deploy record both show a check this way, so "CI passed" is never "G5"
 * alone. The code stays on screen, small and muted, because a refusal quotes it and a person
 * comparing the two needs to find the row.
 */

const CODE_STYLE: CSSProperties = {
  color: 'var(--color-fg-muted)',
  fontSize: 'var(--text-13)',
};

export interface CheckNameProps {
  /** The gate code as the server sent it: `G5`, or `disk`. */
  gate: string;
  /** The app's default branch, when known, so G6 reads "On main". */
  branch?: string | null;
}

export function CheckName({ gate, branch = null }: CheckNameProps) {
  return (
    <>
      {checkName(gate, { branch })} <span style={CODE_STYLE}>{gate}</span>
    </>
  );
}
