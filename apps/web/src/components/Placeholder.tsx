import { Page, PageHeader } from '@d3cloud/ui';

/**
 * A screen that a later task fills. It renders its real title so the route, the nav item and the
 * page's one `<h1>` are right from the start, and says which task owns it.
 */
export function Placeholder({ title, task }: { title: string; task: string }) {
  return (
    <Page>
      <PageHeader title={title} description={`Coming in ${task}.`} />
    </Page>
  );
}
