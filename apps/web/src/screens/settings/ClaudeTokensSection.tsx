import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Cluster,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  PageHeader,
  Section,
  Spinner,
  Stack,
  TabPanel,
  Tabs,
  Textarea,
} from '@d3cloud/ui';
import { KeyRound, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { CopyButton, Mono } from '../../components/Copyable';
import { relativeTime, shortDate, tokens as tokenApi, type TokenCreated, type TokenSummary } from '../../lib/admin';
import type { RefusalError } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { claudeAddCommand, deploySnippetFor, envLine, mcpJsonWithEnv, mcpUrl, TOKEN_ENV, TOOLS } from '../../lib/connect';
import { RefusalAlert, asRefusal } from './shared';

/**
 * Settings › Claude & tokens (SHP-T-3.12, SHP-REQ-046, SHP-ADR-006). "Connect a Claude session"
 * comes first and holds the page's only token-creation form: a token scoped to chosen apps, the
 * exact `claude mcp add` command (or a repo `.mcp.json` that holds no secret), a check that turns
 * green on the token's first MCP call, and the CLAUDE.md snippet. Below it, every token and its
 * last use, each revocable after a confirmation (SHP-REQ-170: one form, one list).
 *
 * A viewer reads the connect steps and is told who can make the token; the token list needs a
 * state-changing role, as the old API tokens screen did, so a viewer is not shown it at all.
 */

/** How often the page asks whether the new token has been used, and for how long. */
export const CONNECT_POLL_MS = 3000;
export const CONNECT_POLL_LIMIT_MS = 15 * 60 * 1000;

/** A token nobody has used for this long is worth revoking. */
export const UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const PLACEHOLDER = '<your token>';

/** Live, and neither used nor made in the last thirty days. */
export function isUnused(t: TokenSummary, now: number = Date.now()): boolean {
  if (t.revokedAt !== null) return false;
  const last = Date.parse(t.lastUsedAt ?? t.createdAt);
  return !Number.isNaN(last) && now - last > UNUSED_AFTER_MS;
}

function TokenForm({ apps, onCreated }: { apps: string[]; onCreated: (t: TokenCreated) => void }) {
  const [label, setLabel] = useState('Claude Code');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const all = apps.length > 0 && chosen.length === apps.length;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    tokenApi
      .create(label.trim(), chosen)
      .then(onCreated)
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (apps.length === 0) {
    return (
      <Alert tone="info" title="No apps yet">
        The agent has not reported any app, so there is nothing for Claude Code to act on yet.
      </Alert>
    );
  }

  return (
    <Stack as="form" gap="16" noValidate onSubmit={submit} aria-label="Make a token">
      <RefusalAlert refusal={refusal} />
      <FormField label="Name" help="So you can tell your tokens apart in the list below — e.g. “Claude Code on my laptop”.">
        <Input
          name="label"
          autoComplete="off"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
      </FormField>
      <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <legend className="shp-status__detail">Apps Claude Code may see and deploy</legend>
        <Stack gap="8">
          <Checkbox
            label="All apps"
            name="all"
            checked={all}
            onCheckedChange={(checked) => {
              setChosen(checked === true ? [...apps] : []);
            }}
          />
          {apps.map((name) => (
            <Checkbox
              key={name}
              label={name}
              name="apps"
              value={name}
              checked={chosen.includes(name)}
              onCheckedChange={(checked) => {
                setChosen((prev) => (checked === true ? [...prev.filter((n) => n !== name), name] : prev.filter((n) => n !== name)));
              }}
            />
          ))}
        </Stack>
      </fieldset>
      <FormActions align="start">
        <Button type="submit" variant="primary" icon={<KeyRound />} loading={busy} disabled={label.trim() === '' || chosen.length === 0}>
          Make the token
        </Button>
      </FormActions>
    </Stack>
  );
}

/** Step 3: green once the new token's first MCP call arrives (`lastUsedAt` is set on first use). */
function ConnectionCheck({ created, used, polling }: { created: TokenCreated | null; used: TokenSummary | null; polling: boolean }) {
  if (created === null) {
    return <p className="shp-status__detail">Make a token first; this turns green when Claude Code first calls Shipyard with it.</p>;
  }
  if (used !== null && used.lastUsedAt !== null) {
    return (
      <Alert tone="success" title="Claude Code is connected">
        “{used.label}” first called Shipyard {relativeTime(used.lastUsedAt)}
        {used.lastUsedIp === null ? '' : ` from ${used.lastUsedIp}`}. Ask it “what’s live on Shipyard?” to see it work.
      </Alert>
    );
  }
  return (
    <Stack gap="8">
      {polling ? (
        <Cluster gap="8" align="center">
          <Spinner size="sm" label="Waiting for Claude Code’s first call" />
          <span className="shp-status__headline">Waiting for Claude Code’s first call…</span>
        </Cluster>
      ) : (
        <Alert tone="warning" title="No call yet">
          This page stopped checking. Reload it after trying again.
        </Alert>
      )}
      <p className="shp-status__detail">
        In Claude Code, run <code>/mcp</code>: <code>shipyard</code> should be listed as connected. Then ask “what’s live on Shipyard?” —
        its first call turns this green. If <code>/mcp</code> shows it failed, the token was mistyped or revoked.
      </p>
    </Stack>
  );
}

function ConnectCard({
  can,
  apps,
  list,
  onRefresh,
}: {
  can: boolean;
  apps: string[];
  list: TokenSummary[] | null;
  onRefresh: () => void;
}) {
  const origin = window.location.origin;
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [createdAt, setCreatedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const used = created === null ? null : (list?.find((t) => t.id === created.id) ?? null);
  const connected = used !== null && used.lastUsedAt !== null;
  const polling = created !== null && !connected && now - createdAt < CONNECT_POLL_LIMIT_MS;

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      onRefresh();
    }, CONNECT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [polling, onRefresh]);

  const token = created?.token ?? PLACEHOLDER;
  const command = claudeAddCommand(origin, token);
  const mcpJson = mcpJsonWithEnv(origin);
  const snippet = deploySnippetFor(origin);
  const exportLine = envLine(token);

  return (
    <Section
      title="Connect a Claude session"
      description="Let Claude Code see what is live and deploy through Shipyard from any repo — no SSH, and every deploy still passes every check."
    >
      <Stack gap="24">
        <Section
          surface="plain"
          headingLevel={3}
          title="1. Make a token"
          description="One token per machine or repo, limited to the apps you tick. You can revoke it any time."
        >
          {!can ? (
            <Alert tone="info" title="A deployer makes the token">
              Your account can view but not deploy, so it cannot make a token that deploys. Ask a deployer or an admin for one, then follow
              step 2 with it.
            </Alert>
          ) : created === null ? (
            <TokenForm
              apps={apps}
              onCreated={(t) => {
                setCreated(t);
                setCreatedAt(Date.now());
                setNow(Date.now());
                onRefresh();
              }}
            />
          ) : (
            <Stack gap="12">
              <Alert tone="success" title={`Token “${created.label}” made`}>
                It may act on {created.apps.join(', ')}. It is in the commands below and is shown only on this page, this once — copy them
                before you leave.
              </Alert>
              <FormField label="Token">
                <Stack gap="8">
                  <Mono value={created.token} />
                  <div>
                    <CopyButton text={created.token} label="Copy token" />
                  </div>
                </Stack>
              </FormField>
              <FormActions align="start">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCreated(null);
                  }}
                >
                  Make another token
                </Button>
              </FormActions>
            </Stack>
          )}
        </Section>

        <Section
          surface="plain"
          headingLevel={3}
          title="2. Add Shipyard to Claude Code"
          description="Pick one. The first is simplest; the second suits a repo you share."
        >
          <Tabs
            aria-label="How to add Shipyard"
            defaultValue="user"
            items={[
              { value: 'user', label: 'Every repo on this machine' },
              { value: 'repo', label: 'One repo' },
            ]}
          >
            <TabPanel value="user">
              <Stack gap="8">
                <p className="shp-status__detail">Run this once in a terminal. The token is kept in your own Claude Code settings, not in any repo.</p>
                <Mono value={command} block />
                <div>
                  <CopyButton text={command} label="Copy command" />
                </div>
              </Stack>
            </TabPanel>
            <TabPanel value="repo">
              <Stack gap="12">
                <FormField label=".mcp.json at the repo root" help={`Safe to commit: it names $${TOKEN_ENV}, never the token.`}>
                  <Stack gap="8">
                    <Mono value={mcpJson} block />
                    <div>
                      <CopyButton text={mcpJson} label="Copy .mcp.json" />
                    </div>
                  </Stack>
                </FormField>
                <FormField label="Your shell profile (~/.zshrc)" help="Then open a new terminal before starting Claude Code.">
                  <Stack gap="8">
                    <Mono value={exportLine} block />
                    <div>
                      <CopyButton text={exportLine} label="Copy line" />
                    </div>
                  </Stack>
                </FormField>
              </Stack>
            </TabPanel>
          </Tabs>
        </Section>

        <Section surface="plain" headingLevel={3} title="3. Check it works">
          <ConnectionCheck created={created} used={used} polling={polling} />
        </Section>

        <Section
          surface="plain"
          headingLevel={3}
          title="4. Teach the repo how to deploy"
          description="Optional, and worth it: paste this into the repo’s CLAUDE.md so Claude Code deploys through Shipyard, names itself, and reports what it deployed."
        >
          <Stack gap="8">
            <Textarea mono readOnly aria-label="CLAUDE.md snippet" rows={10} value={snippet} />
            <div>
              <CopyButton text={snippet} label="Copy snippet" />
            </div>
          </Stack>
        </Section>

        <Section
          surface="plain"
          headingLevel={3}
          title="What Claude Code can do"
          description={`Shipyard’s MCP server at ${mcpUrl(origin)}. Approval-required apps still wait for a person, and a token only reaches the apps it names.`}
        >
          <DataList aria-label="MCP tools">
            {TOOLS.map((tool) => (
              <DataListRow key={tool.name} truncate={false} title={<code>{tool.name}</code>} description={tool.does} />
            ))}
          </DataList>
        </Section>
      </Stack>
    </Section>
  );
}

function tokenDescription(t: TokenSummary): string {
  const used =
    t.lastUsedAt === null ? 'never used' : `last used ${relativeTime(t.lastUsedAt)}${t.lastUsedIp === null ? '' : ` from ${t.lastUsedIp}`}`;
  return `${t.apps.join(', ')} · created ${shortDate(t.createdAt)} · ${used}`;
}

function TokenMeta({ t, now }: { t: TokenSummary; now: number }) {
  if (t.revokedAt !== null) return <Badge tone="danger">Revoked</Badge>;
  return (
    <span className="shp-row-meta">
      {isUnused(t, now) ? <Badge tone="warning">Unused for 30 days</Badge> : null}
      <code>{t.prefix}…</code>
    </span>
  );
}

function TokenList({ list, onRevoked }: { list: TokenSummary[]; onRevoked: (row: TokenSummary) => void }) {
  const [revoking, setRevoking] = useState<TokenSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const now = Date.now();
  const active = list.filter((t) => t.revokedAt === null).length;

  const revoke = () => {
    if (revoking === null) return;
    setBusy(true);
    setRefusal(null);
    tokenApi
      .revoke(revoking.id)
      .then((row) => {
        onRevoked(row);
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
    <Section
      title={`Tokens (${String(active)} active)`}
      description="Bearer tokens for Claude Code sessions and CI, each limited to named apps, and when each last called Shipyard."
    >
      <Stack gap="16">
        <RefusalAlert refusal={refusal} />
        <DataList
          aria-label="API tokens"
          empty={
            <EmptyState kind="empty" size="inline" heading="No tokens yet" headingLevel={3}>
              Make one above for each machine or repo that deploys through Claude Code, scoped to its apps.
            </EmptyState>
          }
        >
          {list.map((t) => (
            <DataListRow
              key={t.id}
              title={t.label}
              description={tokenDescription(t)}
              meta={<TokenMeta t={t} now={now} />}
              actions={
                t.revokedAt === null ? (
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
        <Modal
          open={revoking !== null}
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          title="Revoke this token?"
          description={revoking === null ? undefined : `“${revoking.label}” stops working at once. Anything using it must be given a new token.`}
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
      </Stack>
    </Section>
  );
}

export function ClaudeTokensSection() {
  const can = useCan();
  const [apps, setApps] = useState<string[]>([]);
  const [list, setList] = useState<TokenSummary[] | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

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
    // A viewer can make no token and sees no list, so there is nothing to read for them.
    if (can) void load();
  }, [can, load]);

  // A new token, and each poll while waiting for its first call, re-reads the one list both cards show.
  const refreshList = useCallback(() => {
    void tokenApi
      .list()
      .then(setList)
      .catch(() => undefined);
  }, []);

  return (
    <Stack gap="24">
      <PageHeader title="Claude & tokens" description="Connect Claude Code to this Shipyard, and see every token that can reach it." />
      <RefusalAlert refusal={refusal} />
      <ConnectCard can={can} apps={apps} list={list} onRefresh={refreshList} />
      {can ? (
        list === null ? (
          refusal === null ? (
            <Spinner label="Loading tokens" />
          ) : null
        ) : (
          <TokenList
            list={list}
            onRevoked={(row) => {
              setList((prev) => (prev === null ? prev : prev.map((t) => (t.id === row.id ? row : t))));
            }}
          />
        )
      ) : null}
    </Stack>
  );
}
