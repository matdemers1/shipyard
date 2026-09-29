import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Cluster,
  DataList,
  DataListRow,
  FormActions,
  FormField,
  Input,
  Link,
  Page,
  PageHeader,
  Section,
  Spinner,
  Stack,
  TabPanel,
  Tabs,
  Textarea,
} from '@d3cloud/ui';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { CopyButton, Mono } from '../components/Copyable';
import { relativeTime, tokens as tokenApi, type TokenCreated, type TokenSummary } from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { useCan } from '../lib/auth';
import { claudeAddCommand, DEPLOY_SNIPPET, envLine, mcpJsonWithEnv, mcpUrl, TOKEN_ENV, TOOLS } from '../lib/connect';

/**
 * Connect Claude Code (SHP-T-3.12), `/connect`: everything needed to point Claude Code at this
 * Shipyard's MCP server, in order — what it can do, a token scoped to chosen apps, the command
 * (or a repo `.mcp.json` that holds no secret), a check that turns green on the token's first
 * MCP call, and the CLAUDE.md snippet. A viewer reads it all and is told who can make the token.
 */

/** How often the page asks whether the new token has been used, and for how long. */
export const CONNECT_POLL_MS = 3000;
export const CONNECT_POLL_LIMIT_MS = 15 * 60 * 1000;

const PLACEHOLDER = '<your token>';

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
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
    <Stack as="form" gap="16" noValidate onSubmit={submit}>
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
      <FormField label="Name" help="So you can tell your tokens apart on API tokens — e.g. “Claude Code on my laptop”.">
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

export function Connect() {
  const can = useCan();
  const origin = window.location.origin;
  const [apps, setApps] = useState<string[]>([]);
  const [list, setList] = useState<TokenSummary[] | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [createdAt, setCreatedAt] = useState(0);

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

  const used = created === null ? null : (list?.find((t) => t.id === created.id) ?? null);
  const connected = used !== null && used.lastUsedAt !== null;
  const [now, setNow] = useState(() => Date.now());
  const polling = created !== null && !connected && now - createdAt < CONNECT_POLL_LIMIT_MS;

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void tokenApi
        .list()
        .then(setList)
        .catch(() => undefined);
    }, CONNECT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [polling]);

  const token = created?.token ?? PLACEHOLDER;
  const command = claudeAddCommand(origin, token);
  const mcpJson = mcpJsonWithEnv(origin);
  const exportLine = envLine(token);
  const others = (list ?? []).filter((t) => t.revokedAt === null && t.id !== created?.id);

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader
          title="Connect Claude Code"
          description="Let Claude Code see what is live and ship through Shipyard from any repo — no SSH, and every deploy still passes every check."
        />

        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}

        <Section
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
                void load();
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
            </Stack>
          )}
        </Section>

        <Section title="2. Add Shipyard to Claude Code" description="Pick one. The first is simplest; the second suits a repo you share.">
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
                <p className="shp-status__detail">
                  Run this once in a terminal. The token is kept in your own Claude Code settings, not in any repo.
                </p>
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

        <Section title="3. Check it works">
          <ConnectionCheck created={created} used={used} polling={polling} />
        </Section>

        <Section
          title="4. Teach the repo how to deploy"
          description="Optional, and worth it: paste this into the repo’s CLAUDE.md so Claude Code deploys through Shipyard, names itself, and reports what shipped."
        >
          <Stack gap="8">
            <Textarea mono readOnly aria-label="CLAUDE.md snippet" rows={10} value={DEPLOY_SNIPPET} />
            <div>
              <CopyButton text={DEPLOY_SNIPPET} label="Copy snippet" />
            </div>
          </Stack>
        </Section>

        <Section
          title="What Claude Code can do"
          description={`Shipyard’s MCP server at ${mcpUrl(origin)}. Approval-required apps still wait for a person, and a token only reaches the apps it names.`}
        >
          <DataList aria-label="MCP tools">
            {TOOLS.map((tool) => (
              <DataListRow key={tool.name} truncate={false} title={<code>{tool.name}</code>} description={tool.does} />
            ))}
          </DataList>
        </Section>

        {others.length > 0 ? (
          <Section
            title="Already connected"
            description="Tokens already out there and when each last called Shipyard."
            actions={
              <Link asChild>
                <RouterLink to="/tokens">Manage tokens</RouterLink>
              </Link>
            }
          >
            <DataList aria-label="Existing tokens">
              {others.map((t) => (
                <DataListRow
                  key={t.id}
                  title={t.label}
                  description={t.apps.join(', ')}
                  meta={
                    t.lastUsedAt === null ? (
                      <Badge tone="neutral">Never used</Badge>
                    ) : (
                      <Badge tone="neutral">{relativeTime(t.lastUsedAt)}</Badge>
                    )
                  }
                />
              ))}
            </DataList>
          </Section>
        ) : null}
      </Stack>
    </Page>
  );
}
