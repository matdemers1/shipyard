import { Button } from '@d3cloud/ui';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '../lib/admin';

/** A secret, command or snippet: monospace, wrapping, preformatted where it has lines. */
export function Mono({ value, block = false }: { value: string; block?: boolean }) {
  const style = { overflowWrap: 'anywhere', wordBreak: 'break-all', whiteSpace: block ? 'pre-wrap' : 'normal' } as const;
  return block ? (
    <pre style={{ ...style, margin: 0 }}>
      <code>{value}</code>
    </pre>
  ) : (
    <code style={style}>{value}</code>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={<Copy />}
      onClick={() => {
        void copyText(text).then(setCopied);
      }}
    >
      {copied === true ? 'Copied' : copied === false ? 'Copy failed — select it' : label}
    </Button>
  );
}
