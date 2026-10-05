import { Button } from '@d3cloud/ui';
import { Smartphone } from 'lucide-react';

/**
 * "Open in D3 Constellation" (SHP-T-11.1): the same app or deploy in the native app, by a
 * `d3constellation://<host>/shipyard/<path>` link — the host picks the connection there, so the
 * link never crosses servers. Offered only on Apple devices; iPadOS Safari calls itself a Mac.
 */
export function constellationLink(path: string, host: string = window.location.host): string {
  return `d3constellation://${host}/shipyard/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function OpenInConstellation({ path }: { path: string }) {
  if (typeof navigator === 'undefined' || !/iPhone|iPad|Macintosh/.test(navigator.userAgent)) return null;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={<Smartphone />}
      onClick={() => {
        window.location.href = constellationLink(path);
      }}
    >
      Open in D3 Constellation
    </Button>
  );
}
