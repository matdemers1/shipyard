import {
  Activity,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CirclePause,
  CircleX,
  GitCommitHorizontal,
  LoaderCircle,
  Package,
  Rocket,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { STATE_LABEL, type StageKey, type StageState } from './stages';

/** One state's mark. Icons are decoration (aria-hidden): the state is always also in text. */
const STATE_ICON: Record<StageState, LucideIcon> = {
  done: CircleCheck,
  running: LoaderCircle,
  waiting: CircleDashed,
  failed: CircleX,
  held: CirclePause,
  skipped: CircleMinus,
};

/** The stage's own glyph, shown beside its label in the full lane. */
const STAGE_ICON: Record<StageKey, LucideIcon> = {
  push: GitCommitHorizontal,
  ci: Workflow,
  images: Package,
  checks: ShieldCheck,
  deploy: Rocket,
  live: Activity,
};

export function StageGlyph({ stage }: { stage: StageKey }) {
  const Icon = STAGE_ICON[stage];
  return <Icon aria-hidden="true" className="shp-pipe-glyph" size={16} strokeWidth={2} />;
}

/**
 * A stage's state as a node (SHP-T-13.7): a Lucide mark in the state's colour — accent while
 * running, danger when failed, quiet otherwise. Success is only ever this icon, never a green
 * badge. `sm` is the Home row's size, `md` the lane's.
 */
export function PipeNode({ state, size = 'md' }: { state: StageState; size?: 'sm' | 'md' }) {
  const Icon = STATE_ICON[state];
  const px = size === 'sm' ? 16 : 24;
  return (
    <span className="shp-pipe-node" data-state={state} data-size={size} title={STATE_LABEL[state]}>
      <Icon aria-hidden="true" size={px} strokeWidth={2} />
    </span>
  );
}
