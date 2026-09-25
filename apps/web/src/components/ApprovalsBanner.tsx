import { Alert, Button, Cluster, FormActions, Modal, ModalClose, Stack } from '@d3cloud/ui';
import { useState } from 'react';
import { request, RefusalError } from '../lib/api';
import type { PendingApproval } from '../lib/home';
import type { SheetAction } from './DryRunSheet';

export interface ApprovalsBannerProps {
  approvals: PendingApproval[];
  onReview: (action: SheetAction) => void;
  /** Called after a deny succeeds, to refresh the list. */
  onDenied: () => void;
}

/** The approvals banner at the top of home (SHP-D-071, SHP-REQ-060). */
export function ApprovalsBanner({ approvals, onReview, onDenied }: ApprovalsBannerProps) {
  const [denying, setDenying] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RefusalError | null>(null);

  if (approvals.length === 0) return null;

  const deny = async (approval: PendingApproval) => {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/deploys/${approval.deployId}/deny`, { method: 'POST' });
      setDenying(null);
      onDenied();
    } catch (err) {
      setError(err instanceof RefusalError ? err : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Alert tone="warning" title={`${String(approvals.length)} deploy${approvals.length === 1 ? '' : 's'} waiting on approval`}>
        <Stack gap="8">
          {approvals.map((approval) => (
            <Cluster key={approval.deployId} justify="between" align="center">
              <div>
                {approval.app} · {approval.sha.slice(0, 7)} · {approval.requester.label}
              </div>
              <Cluster gap="8">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onReview({ kind: 'approve', app: approval.app, sha: approval.sha, deployId: approval.deployId });
                  }}
                >
                  Review
                </Button>
                <Button
                  type="button"
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => {
                    setDenying(approval);
                  }}
                >
                  Deny
                </Button>
              </Cluster>
            </Cluster>
          ))}
        </Stack>
      </Alert>
      <Modal
        open={denying !== null}
        onOpenChange={(open) => {
          if (!open) setDenying(null);
        }}
        title={denying === null ? 'Deny deploy' : `Deny ${denying.app} at ${denying.sha.slice(0, 7)}`}
        description="This deploy will not run. It can be requested again later."
        destructive
        footer={
          <FormActions>
            <ModalClose>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={() => {
                if (denying !== null) void deny(denying);
              }}
            >
              Deny
            </Button>
          </FormActions>
        }
      >
        {error !== null ? (
          <Alert tone="danger" title={error.message} dynamic>
            {error.fix}
          </Alert>
        ) : null}
      </Modal>
    </>
  );
}
