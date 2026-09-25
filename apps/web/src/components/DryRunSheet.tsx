import { Modal } from '@d3cloud/ui';

/**
 * What the sheet is asked to confirm (SHP-D-068). Home and App detail open it; approvals open it
 * from the banner. The contract is fixed by the lead so those screens and the sheet (SHP-T-3.3)
 * are built in parallel against the same props.
 */
export type SheetAction =
  | { kind: 'deploy'; app: string; sha: string }
  | { kind: 'rollback'; app: string; sha: string; toDeployId: string }
  | { kind: 'approve'; app: string; sha: string; deployId: string };

export interface DryRunSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while closed. */
  action: SheetAction | null;
  /** Called with the deploy ID once a deploy, rollback or approval has been started. */
  onStarted?: (deployId: string) => void;
}

/** The dry-run sheet (SHP-T-3.3). Placeholder until that task builds it. */
export function DryRunSheet({ open, onOpenChange, action }: DryRunSheetProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={action === null ? 'Deploy' : `${action.kind} ${action.app}`}>
      Coming in SHP-T-3.3.
    </Modal>
  );
}
