import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  Page,
  PageHeader,
  Section,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  copyText,
  mcpSnippet,
  relativeTime,
  shortDate,
  tokens as tokenApi,
  type TokenCreated,
  type TokenSummary,
} from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { useCan } from '../lib/auth';

/**
 * S11 API tokens (SHP-REQ-046): one per repo, scoped to named apps. A new token is shown once —
 * with a copy button and the Claude Code MCP config that uses it — and never again; the server
 * keeps only its hash. Revoking asks first. A viewer sees the list and no actions (SHP-REQ-105).
 */

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

/** A secret or snippet: monospace, wrapping, preformatted where it has lines. */
function Mono({ value, block = false }: { value: string; block?: boolean }) {
  const style = { overflowWrap: 'anywhere', wordBreak: 'break-all', whiteSpace: block ? 'pre-wrap' : 'normal' } as const;
  return block ? (
    <pre style={{ ...style, margin: 0 }}>
      <code>{value}</code>
    </pre>
  ) : (
    <code style={style}>{value}</code>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
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

function ShownOnce({ created, onDismiss }: { created: TokenCreated; onDismiss: () => void }) {
  const snippet = mcpSnippet(window.location.origin, created.token);
  return (
    <Card>
      <Stack gap="16">
        <Alert tone="success" title={`Token “${created.label}” created`}>
          Copy it now: it is shown this once and cannot be shown again. It may act on {created.apps.join(', ')}.
        </Alert>
        <FormField label="Token">
          <Stack gap="8">
            <Mono value={created.token} />
            <div>
              <CopyButton text={created.token} label="Copy token" />
            </div>
          </Stack>
        </FormField>
        <FormField label="Claude Code MCP config" help="Add to the repo's .mcp.json.">
          <Stack gap="8">
            <Mono value={snippet} block />
            <div>
              <CopyButton text={snippet} label="Copy config" />
            </div>
          </Stack>
        </FormField>
        <FormActions align="start">
          <Button type="button" variant="primary" onClick={onDismiss}>
            I have copied it
          </Button>
        </FormActions>
      </Stack>
    </Card>
  );
}

function CreateForm({ apps, onCreated }: { apps: string[]; onCreated: (t: TokenCreated) => void }) {
  const [label, setLabel] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    tokenApi
      .create(label.trim(), chosen)
      .then((t) => {
        setLabel('');
        setChosen([]);
        onCreated(t);
      })
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Section title="New token" description="One per repo, scoped to the apps that repo deploys.">
      <Stack as="form" gap="16" noValidate onSubmit={submit}>
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        <FormField label="Label" help="Usually the repository, e.g. matdemers1/bindery.">
          <Input
            name="label"
            autoComplete="off"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </FormField>
        {apps.length === 0 ? (
          <Alert tone="info" title="No apps yet">
            The agent has not reported any app, so there is nothing to scope a token to.
          </Alert>
        ) : (
          <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend className="shp-visually-hidden">Apps this token may act on</legend>
            <Stack gap="8">
              {apps.map((name) => (
                <Checkbox
                  key={name}
                  label={name}
                  name="apps"
                  value={name}
                  checked={chosen.includes(name)}
                  onCheckedChange={(checked) => {
                    setChosen((prev) =>
                      checked === true ? [...prev.filter((n) => n !== name), name] : prev.filter((n) => n !== name),
                    );
                  }}
                />
              ))}
            </Stack>
          </fieldset>
        )}
        <FormActions align="start">
          <Button
            type="submit"
            variant="primary"
            icon={<KeyRound />}
            loading={busy}
            disabled={label.trim() === '' || chosen.length === 0}
          >
            Create token
          </Button>
        </FormActions>
      </Stack>
    </Section>
  );
}

function tokenDescription(t: TokenSummary): string {
  const used =
    t.lastUsedAt === null
      ? 'never used'
      : `last used ${relativeTime(t.lastUsedAt)}${t.lastUsedIp === null ? '' : ` from ${t.lastUsedIp}`}`;
  return `${t.apps.join(', ')} · created ${shortDate(t.createdAt)} · ${used}`;
}

export function Tokens() {
  const can = useCan();
  const [list, setList] = useState<TokenSummary[] | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [revoking, setRevoking] = useState<TokenSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([tokenApi.list(), tokenApi.appNames()]);
      setList(t);
      setApps(a);
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = () => {
    if (revoking === null) return;
    setBusy(true);
    tokenApi
      .revoke(revoking.id)
      .then((row) => {
        setList((prev) => (prev === null ? prev : prev.map((t) => (t.id === row.id ? row : t))));
        setRevoking(null);
      })
      .catch((error: unknown) => {
        setRevoking(null);
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader
          title="API tokens"
          description="Bearer tokens for Claude Code sessions and CI, each limited to named apps."
          // countNoun, not countLabel: countLabel replaces the heading's whole accessible name.
          {...(list !== null ? { count: list.filter((t) => t.revokedAt === null).length, countNoun: { one: 'live', other: 'live' } } : {})}
        />
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {can && created !== null ? (
          <ShownOnce
            created={created}
            onDismiss={() => {
              setCreated(null);
              void load();
            }}
          />
        ) : null}
        {can && created === null ? <CreateForm apps={apps} onCreated={setCreated} /> : null}
        {list === null && refusal === null ? <Spinner label="Loading tokens" /> : null}
        {list !== null ? (
          <DataList
            aria-label="API tokens"
            empty={
              <EmptyState kind="empty" size="inline" heading="No tokens — create one per repo" headingLevel={2}>
                Each repo that deploys through Claude Code gets its own token, scoped to its apps.
              </EmptyState>
            }
          >
            {list.map((t) => (
              <DataListRow
                key={t.id}
                title={t.label}
                description={tokenDescription(t)}
                meta={
                  t.revokedAt === null ? (
                    <code>{t.prefix}…</code>
                  ) : (
                    <Badge tone="danger">Revoked</Badge>
                  )
                }
                actions={
                  can && t.revokedAt === null ? (
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      icon={<Trash2 />}
                      aria-label={`Revoke ${t.label}`}
                      onClick={() => {
                        setRevoking(t);
                      }}
                    >
                      Revoke
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </DataList>
        ) : null}
        {can ? (
          <Modal
            open={revoking !== null}
            onOpenChange={(open) => {
              if (!open) setRevoking(null);
            }}
            title="Revoke this token?"
            description={
              revoking === null
                ? undefined
                : `“${revoking.label}” stops working at once. Anything using it must be given a new token.`
            }
            destructive
            footer={
              <FormActions>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setRevoking(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" variant="danger" loading={busy} onClick={revoke}>
                  Revoke token
                </Button>
              </FormActions>
            }
          />
        ) : null}
      </Stack>
    </Page>
  );
}
