import { Modal } from '@d3cloud/ui';

export interface DryRunSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: string;
}

/** The dry-run sheet (SHP-T-3.3). Placeholder until that task builds it. */
export function DryRunSheet({ open, onOpenChange, app }: DryRunSheetProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Deploy ${app}`}>
      Coming in SHP-T-3.3.
    </Modal>
  );
}
