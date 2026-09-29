import type { AppStatus } from '../lib/appstatus';

/** An app's status as a dot, a headline and why (SHP-T-3.10). Home's cards and app detail share it. */
export function StatusLine({ status, headingLevel }: { status: AppStatus; headingLevel?: 2 | 3 }) {
  const Headline = headingLevel === undefined ? 'p' : (`h${String(headingLevel)}` as 'h2' | 'h3');
  return (
    <div className="shp-status">
      <span className="shp-status__dot" data-tone={status.tone} data-kind={status.kind} aria-hidden="true" />
      <div className="shp-status__text">
        <Headline className="shp-status__headline">{status.headline}</Headline>
        <p className="shp-status__detail">{status.detail}</p>
      </div>
    </div>
  );
}
