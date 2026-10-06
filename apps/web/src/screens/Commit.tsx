import { EmptyState, Page } from '@d3cloud/ui';

/**
 * One commit's journey, `/apps/:app/commits/:sha` (SHP-T-13.9). Registered by the fleet lead so
 * the route exists before the page; SHP-T-13.9 replaces this placeholder.
 */
export function Commit() {
  return (
    <Page width="narrow">
      <EmptyState title="Commit" description="This page is being built." />
    </Page>
  );
}
