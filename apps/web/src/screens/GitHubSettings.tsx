import { Alert, Badge, Button, FormActions, FormField, Link, Modal, PasswordInput, Section, Spinner, Stack } from '@d3cloud/ui';
import type { GitHubRateLimit, GitHubSettings, GitHubTestResult } from '@shipyard/schema';
import { FlaskConical, Power, Save } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { relativeTime, shortDate } from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { settings as settingsApi } from '../lib/settings';

/**
 * Settings → GitHub (SHP-T-3.13): the server's read-only GitHub token. Without one the server calls
 * GitHub anonymously — 60 requests an hour per address, shared with the agent — and a busy Home
 * screen runs out, after which Shipyard sees no new commits and offers nothing to deploy. The
 * token is write-only; GITHUB_TOKEN_SERVER in server.env wins and makes this section read-only.
 */

/** Where to make the right kind of token: fine-grained, public repositories, read-only. */
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

function until(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return minutes <= 1 ? 'in a minute' : `in ${String(minutes)} minutes`;
}

/** GitHub's own numbers, in a sentence: the thing that decides whether Shipyard can see commits. */
function RateLimit({ r, problem }: { r: GitHubRateLimit | null; problem: string | null }) {
  if (r === null) {
    return (
      <Alert tone="warning" title="GitHub's rate limit could not be read">
        {problem ?? 'GitHub did not answer.'}
      </Alert>
    );
  }
  const who = r.authenticated ? 'with a token' : 'anonymously';
  const line = `GitHub counts Shipyard ${who}: ${String(r.remaining)} of ${String(r.limit)} requests left this hour, resetting ${until(r.resetAt)}.`;
  if (r.remaining === 0) {
    return (
      <Alert tone="danger" title="Out of GitHub requests">
        {line} Until then Shipyard cannot see new commits, so nothing is offered to deploy.
        {r.authenticated ? '' : ' Adding a token raises the limit to 5,000 an hour.'}
      </Alert>
    );
  }
  if (!r.authenticated) {
    return (
      <Alert tone="warning" title="Calling GitHub without a token">
        {line} A busy Home screen can use that up in minutes. Add a token below.
      </Alert>
    );
  }
  return (
    <p>
      <Badge tone="neutral">Token in use</Badge> {line}
    </p>
  );
}

function TestAnswer({ result }: { result: GitHubTestResult }) {
  if (result.ok) {
    return (
      <Alert tone="success" title="GitHub accepted it" dynamic>
        {result.rateLimit === undefined
          ? 'GitHub answered.'
          : `${String(result.rateLimit.remaining)} of ${String(result.rateLimit.limit)} requests left this hour.`}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="GitHub did not accept it" dynamic>
      {result.detail ?? 'No answer from GitHub.'}
    </Alert>
  );
}

function TokenForm({ g, onDone }: { g: GitHubSettings; onDone: (next: GitHubSettings, what: 'saved' | 'cleared') => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [tested, setTested] = useState<GitHubTestResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const run = <T,>(what: 'save' | 'test' | 'clear', call: () => Promise<T>, then: (value: T) => void) => {
    if (busy !== null) return;
    setBusy(what);
    setRefusal(null);
    call()
      .then(then)
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(null);
        setConfirmClear(false);
      });
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    run(
      'save',
      () => settingsApi.saveGitHub(token.trim()),
      (next) => {
        setToken('');
        setTested(null);
        onDone(next, 'saved');
      },
    );
  };

  const help = !g.canStoreSecret
    ? 'SESSION_SECRET is unset in server.env, so a token cannot be stored. Set it and restart.'
    : g.tokenSet
      ? 'A token is stored. Paste a new one to replace it; the stored one is never shown again.'
      : 'Fine-grained, “Public repositories (read-only)”, no other permissions.';

  return (
    <Stack as="form" gap="16" noValidate onSubmit={save} aria-label="GitHub access">
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
      {tested === null ? null : <TestAnswer result={tested} />}
      <FormField label="GitHub token" help={help}>
        <PasswordInput
          name="githubToken"
          autoComplete="off"
          spellCheck={false}
          disabled={!g.canStoreSecret}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTested(null);
          }}
        />
      </FormField>
      <p className="shp-status__detail">
        Make one at{' '}
        <Link href={NEW_TOKEN_URL} target="_blank" rel="noreferrer" variant="inline">
          GitHub → Fine-grained tokens
        </Link>
        . Give it read-only access to public repositories and nothing else — the server faces the internet, so it should hold nothing worth
        stealing.
      </p>
      <FormActions align="start">
        <Button
          type="submit"
          variant="primary"
          icon={<Save />}
          loading={busy === 'save'}
          disabled={token.trim() === ''}
          aria-label="Save GitHub token"
        >
          Save
        </Button>
        <Button
          type="button"
          variant="secondary"
          icon={<FlaskConical />}
          loading={busy === 'test'}
          aria-label={token.trim() === '' ? 'Test the GitHub token in use' : 'Test this GitHub token'}
          onClick={() => {
            run('test', () => settingsApi.testGitHub(token.trim() === '' ? undefined : token.trim()), setTested);
          }}
        >
          Test
        </Button>
        {g.source === 'settings' ? (
          <Button
            type="button"
            variant="danger-ghost"
            icon={<Power />}
            aria-label="Remove the GitHub token"
            onClick={() => {
              setConfirmClear(true);
            }}
          >
            Remove
          </Button>
        ) : null}
      </FormActions>
      <Modal
        open={confirmClear}
        onOpenChange={(open) => {
          if (!open) setConfirmClear(false);
        }}
        title="Remove the GitHub token?"
        description="Shipyard goes back to calling GitHub anonymously — 60 requests an hour — and may stop seeing new commits."
        destructive
        footer={
          <FormActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirmClear(false);
              }}
            >
              Keep it
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={busy === 'clear'}
              onClick={() => {
                run(
                  'clear',
                  () => settingsApi.clearGitHub(),
                  (next) => {
                    onDone(next, 'cleared');
                  },
                );
              }}
            >
              Remove
            </Button>
          </FormActions>
        }
      />
    </Stack>
  );
}

export function GitHubSettingsSection() {
  const [g, setG] = useState<GitHubSettings | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [done, setDone] = useState<'saved' | 'cleared' | null>(null);

  const load = useCallback(async () => {
    try {
      setG(await settingsApi.github());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Home's "Check GitHub access" links here as /settings#github; the section loads after the page.
  const loaded = g !== null;
  useEffect(() => {
    if (loaded && window.location.hash === '#github') document.getElementById('github')?.scrollIntoView();
  }, [loaded]);

  return (
    <Section
      id="github"
      title="GitHub"
      description="How Shipyard reads your repos: new commits, whether CI passed, and what changed. The agent checks GitHub again with its own token before every deploy."
    >
      <Stack gap="16">
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {g === null && refusal === null ? <Spinner label="Loading GitHub settings" /> : null}
        {g === null ? null : (
          <>
            {done === 'saved' ? (
              <Alert tone="success" title="GitHub token saved" dynamic>
                Shipyard uses it from the next request — no restart needed.
              </Alert>
            ) : null}
            {done === 'cleared' ? (
              <Alert tone="success" title="GitHub token removed" dynamic>
                Shipyard now calls GitHub anonymously.
              </Alert>
            ) : null}
            {g.problem === null ? null : (
              <Alert tone="warning" title="The stored token cannot be used">
                {g.problem}
              </Alert>
            )}
            <RateLimit r={g.rateLimit} problem={g.rateLimitProblem} />
            {g.source === 'env' ? (
              <Alert tone="info" title="Set in server.env">
                GITHUB_TOKEN_SERVER in server.env wins over this screen. To change it, edit server.env and restart; to manage the token here
                instead, remove it there.
              </Alert>
            ) : (
              <TokenForm
                key={`${g.source}:${g.updatedAt ?? ''}`}
                g={g}
                onDone={(next, what) => {
                  setG(next);
                  setDone(what);
                }}
              />
            )}
            {g.updatedAt === null ? null : (
              <p>
                Token last changed {shortDate(g.updatedAt)} ({relativeTime(g.updatedAt)}).
              </p>
            )}
          </>
        )}
      </Stack>
    </Section>
  );
}
