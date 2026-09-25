import { EmptyState, Link, Page } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';

export function NotFound() {
  return (
    <Page>
      <EmptyState
        kind="no-results"
        heading="There is no page at this address"
        headingLevel={2}
        action={
          <Link asChild>
            <RouterLink to="/">Go to Home</RouterLink>
          </Link>
        }
      >
        Check the address, or start again from Home.
      </EmptyState>
    </Page>
  );
}
