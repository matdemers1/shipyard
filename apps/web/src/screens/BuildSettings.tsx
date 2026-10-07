import { Alert, Button, FormActions, FormField, Input, Section, SettingsRow, Spinner, Stack } from '@d3cloud/ui';
import type { BuildSettings } from '@shipyard/schema';
import { Save } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { shortDate } from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { settings as settingsApi } from '../lib/settings';

/**
 * Settings › Builds (SHP-REQ-131, SHP-REQ-132, SHP-T-7.11): the BuildKit container's CPU and
 * memory limits, and the size cap its cache garbage collection keeps the cache under. Admin-only.
 * Nothing here talks to Docker or BuildKit — the agent applies a saved change on its next poll,
 * which Host's Disk row reflects once it reports again. When no app builds with Shipyard the form
 * starts collapsed behind "Edit limits", with the reason in one line (SHP-T-13.6).
 */

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

const MIN_CPUS = 0.5;
const MAX_CPUS = 64;
const MIN_MEMORY_MB = 512;
const MAX_MEMORY_MB = 262_144;
const MIN_CACHE_CAP_GB = 1;
const MAX_CACHE_CAP_GB = 2000;

function BuildSettingsForm({ s, onSaved }: { s: BuildSettings; updatedAt: string | null; onSaved: (next: BuildSettings) => void }) {
  const [cpus, setCpus] = useState(String(s.cpus));
  const [memoryMb, setMemoryMb] = useState(String(s.memoryMb));
  const [cacheCapGb, setCacheCapGb] = useState(String(s.cacheCapGb));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const cpusValue = Number(cpus);
  const memoryValue = Number(memoryMb);
  const cacheCapValue = Number(cacheCapGb);
  const valid =
    Number.isFinite(cpusValue) &&
    cpusValue >= MIN_CPUS &&
    cpusValue <= MAX_CPUS &&
    Math.round(cpusValue * 2) === cpusValue * 2 &&
    Number.isInteger(memoryValue) &&
    memoryValue >= MIN_MEMORY_MB &&
    memoryValue <= MAX_MEMORY_MB &&
    Number.isInteger(cacheCapValue) &&
    cacheCapValue >= MIN_CACHE_CAP_GB &&
    cacheCapValue <= MAX_CACHE_CAP_GB;

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setRefusal(null);
    settingsApi
      .saveBuilds({ cpus: cpusValue, memoryMb: memoryValue, cacheCapGb: cacheCapValue })
      .then(onSaved)
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack as="form" gap="16" noValidate onSubmit={save} aria-label="Builds">
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
      <FormField label="CPUs" help={`Half-CPU steps, ${String(MIN_CPUS)} to ${String(MAX_CPUS)}.`}>
        <Input
          name="cpus"
          type="number"
          inputMode="decimal"
          min={MIN_CPUS}
          max={MAX_CPUS}
          step={0.5}
          value={cpus}
          onChange={(e) => {
            setCpus(e.target.value);
          }}
        />
      </FormField>
      <FormField label="Memory (MiB)" help={`${String(MIN_MEMORY_MB)} to ${String(MAX_MEMORY_MB)}.`}>
        <Input
          name="memoryMb"
          type="number"
          inputMode="numeric"
          min={MIN_MEMORY_MB}
          max={MAX_MEMORY_MB}
          step={1}
          value={memoryMb}
          onChange={(e) => {
            setMemoryMb(e.target.value);
          }}
        />
      </FormField>
      <FormField label="Cache cap (GiB)" help={`Garbage collection keeps the BuildKit cache under this size, ${String(MIN_CACHE_CAP_GB)} to ${String(MAX_CACHE_CAP_GB)}.`}>
        <Input
          name="cacheCapGb"
          type="number"
          inputMode="numeric"
          min={MIN_CACHE_CAP_GB}
          max={MAX_CACHE_CAP_GB}
          step={1}
          value={cacheCapGb}
          onChange={(e) => {
            setCacheCapGb(e.target.value);
          }}
        />
      </FormField>
      <FormActions align="start">
        <Button type="submit" variant="primary" icon={<Save />} loading={busy} disabled={!valid} aria-label="Save build limits">
          Save
        </Button>
      </FormActions>
    </Stack>
  );
}

export function BuildSettingsSection({ unusedLine = null }: { unusedLine?: string | null }) {
  const [s, setS] = useState<BuildSettings | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const collapsed = unusedLine !== null && !open;

  const load = useCallback(async () => {
    try {
      setS(await settingsApi.builds());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary =
    s === null ? null : `${String(s.cpus)} CPU${s.cpus === 1 ? '' : 's'}, ${String(s.memoryMb)} MiB, cache capped at ${String(s.cacheCapGb)} GiB.`;

  return (
    <Section
      title="BuildKit limits"
      description="The BuildKit container's CPU and memory limits, and the size cap its cache garbage collection keeps it under. Applied on the agent's next poll — no restart."
    >
      <Stack gap="16">
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {s === null && refusal === null ? <Spinner label="Loading build limits" /> : null}
        {s === null ? null : (
          <>
            {unusedLine === null ? null : (
              <SettingsRow
                title={unusedLine}
                description={summary}
                control={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={open}
                    aria-controls="shp-build-limits"
                    onClick={() => {
                      setOpen(!open);
                    }}
                  >
                    Edit limits
                  </Button>
                }
              />
            )}
            {savedAt === null ? null : (
              <Alert tone="success" title="Build limits saved" dynamic>
                The agent applies them on its next poll.
              </Alert>
            )}
            {collapsed ? null : (
              <div id="shp-build-limits">
                <BuildSettingsForm
                  key={`${String(s.cpus)}:${String(s.memoryMb)}:${String(s.cacheCapGb)}`}
                  s={s}
                  updatedAt={savedAt}
                  onSaved={(next) => {
                    setS(next);
                    setSavedAt(new Date().toISOString());
                  }}
                />
              </div>
            )}
            {savedAt === null ? null : <p className="shp-status__detail">Last saved {shortDate(savedAt)}.</p>}
          </>
        )}
      </Stack>
    </Section>
  );
}
