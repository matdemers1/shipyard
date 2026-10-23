import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';

import * as schemaExports from '../src/index.js';
import {
  Manifest,
  ErrorEnvelope,
  Refusal,
  AgentReport,
  AgentRelease,
  PollResponse,
  StepJournal,
  TargetResult,
  DeployRequest,
  HealthResponse,
  AppName,
  Sha40,
  ImageTag,
  Digest,
  GhRepo,
  ProjectCode,
  Argv,
  Step,
  Gate,
  ErrorCode,
  DeployTargetState,
  SignatureHeaders,
  PollRequest,
  Requester,
  DeployKind,
  DeployAccepted,
  LoginRequest,
  TotpRequest,
  EnrolRequest,
  TokenCreate,
  TokenCreated,
  DeployStatus,
  TargetProgress,
  FreezeReason,
  FreezeRequest,
  Freeze,
  FreezeInfo,
  RestoreRequest,
  RestoreCandidate,
  RestoreCandidates,
  ScheduleRequest,
  RolloutRequest,
  RolloutItem,
  PatWarning,
  SystemVersions,
  SystemAgent,
  SystemOutbox,
  SystemBackupRun,
  SystemBackups,
  SystemStatus,
  SetupStatus,
  SetupStartRequest,
  SetupStarted,
  SetupCompleteRequest,
  IssuerUrl,
  D3AuthSource,
  D3AuthSettingsUpdate,
  D3AuthTestRequest,
  D3AuthTestResult,
  D3AuthSettings,
  RelayUrl,
  MailSettingsUpdate,
  MailSettings,
  GitHubRateLimit,
  GitHubSettings,
  GitHubSettingsUpdate,
  GitHubTestRequest,
  GitHubTestResult,
  GitHubToken,
  MailTestResult,
  BuildName,
  BuildStage,
  BuildState,
  BuildTrigger,
  BuildJob,
  BuildProgress,
  BuildResult,
  BuildConfig,
  BuildSettings,
  BuildSettingsUpdate,
  AgentBuildCache,
  ContainerTier,
  ContainerState,
  ContainerHealth,
  ComposeRef,
  HostPort,
  HostMount,
  ContainerStats,
  HostContainer,
  HostVolume,
  HostImage,
  HostNetwork,
  HostFilesystem,
  HostDisk,
  HostBuilderCache,
  HostInventory,
  HostSample,
  HostSnapshot,
  HostResponse,
  ComposeConfig,
  StackManifest,
  AgentStack,
  LifecycleVerb,
  ActionTarget,
  ServiceName,
  ContainerId,
  ActionState,
  ActionStatus,
  ActionPage,
  ActionJob,
  ActionProgress,
  ActionResult,
  ActionRequest,
  LogsRequest,
  LogsSession,
  LogsJob,
  LogLine,
  LogsChunk,
  LogsChunkAck,
  ShipyardActionInput,
  ShipyardLogsInput,
  ServiceConfig,
  BackupStep,
  StackTrack,
  StackService,
  StackHealth,
  AgentStackService,
  StackUpdateJob,
  StackUpdateStep,
  StackUpdateProgress,
  StackUpdateResult,
  StackUpdateState,
  StackUpdateStatus,
  StackUpdatePage,
  StackUpdateRequest,
  StackRollbackRequest,
  ShipyardStackUpdateInput,
  VolumeName,
  VolumeOwner,
  VolumeBackupSettings,
  MaintenanceJob,
  VolumeArchive,
  PruneItem,
  MaintenanceStep,
  MaintenanceProgress,
  MaintenanceResult,
  MaintenanceState,
  MaintenanceStatus,
  MaintenancePage,
  VolumeBackupRequest,
  VolumeRestoreRequest,
  VolumeDeleteRequest,
  PruneRequest,
  ShipyardPruneInput,
  ShipyardVolumeBackupInput,
} from '../src/index.js';
import {
  ShipyardStatusInput,
  ShipyardDryRunInput,
  ShipyardDeployInput,
  ShipyardDeployStatusInput,
  ShipyardRollbackInput,
  ShipyardBuildInput,
  ShipyardBuildStatusInput,
  ShipyardHostInput,
} from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, 'fixtures');

// Each entry names a fixture directory under test/fixtures/<name> and the
// schema every file in it should be checked against.
const SCHEMAS: Record<string, ZodType> = {
  manifest: Manifest,
  errorEnvelope: ErrorEnvelope,
  refusal: Refusal,
  agentReport: AgentReport,
  agentRelease: AgentRelease,
  pollResponse: PollResponse,
  stepJournal: StepJournal,
  targetResult: TargetResult,
  deployRequest: DeployRequest,
  healthResponse: HealthResponse,
  mcpStatus: ShipyardStatusInput,
  mcpDryRun: ShipyardDryRunInput,
  mcpDeploy: ShipyardDeployInput,
  mcpDeployStatus: ShipyardDeployStatusInput,
  mcpRollback: ShipyardRollbackInput,
  mcpBuild: ShipyardBuildInput,
  mcpBuildStatus: ShipyardBuildStatusInput,
  mcpHost: ShipyardHostInput,
  appName: AppName,
  sha40: Sha40,
  imageTag: ImageTag,
  digest: Digest,
  ghRepo: GhRepo,
  projectCode: ProjectCode,
  argv: Argv,
  step: Step,
  gate: Gate,
  errorCode: ErrorCode,
  deployTargetState: DeployTargetState,
  signatureHeaders: SignatureHeaders,
  pollRequest: PollRequest,
  requester: Requester,
  deployKind: DeployKind,
  deployAccepted: DeployAccepted,
  loginRequest: LoginRequest,
  totpRequest: TotpRequest,
  enrolRequest: EnrolRequest,
  tokenCreate: TokenCreate,
  tokenCreated: TokenCreated,
  deployStatus: DeployStatus,
  targetProgress: TargetProgress,
  freezeReason: FreezeReason,
  freezeRequest: FreezeRequest,
  freeze: Freeze,
  freezeInfo: FreezeInfo,
  restoreRequest: RestoreRequest,
  restoreCandidate: RestoreCandidate,
  restoreCandidates: RestoreCandidates,
  scheduleRequest: ScheduleRequest,
  rolloutRequest: RolloutRequest,
  rolloutItem: RolloutItem,
  patWarning: PatWarning,
  systemVersions: SystemVersions,
  systemAgent: SystemAgent,
  systemOutbox: SystemOutbox,
  systemBackupRun: SystemBackupRun,
  systemBackups: SystemBackups,
  systemStatus: SystemStatus,
  setupStatus: SetupStatus,
  setupStartRequest: SetupStartRequest,
  setupStarted: SetupStarted,
  setupCompleteRequest: SetupCompleteRequest,
  issuerUrl: IssuerUrl,
  d3AuthSource: D3AuthSource,
  d3AuthSettingsUpdate: D3AuthSettingsUpdate,
  d3AuthTestRequest: D3AuthTestRequest,
  d3AuthTestResult: D3AuthTestResult,
  d3AuthSettings: D3AuthSettings,
  relayUrl: RelayUrl,
  mailSettingsUpdate: MailSettingsUpdate,
  mailSettings: MailSettings,
  mailTestResult: MailTestResult,
  gitHubToken: GitHubToken,
  gitHubSettingsUpdate: GitHubSettingsUpdate,
  gitHubTestRequest: GitHubTestRequest,
  gitHubRateLimit: GitHubRateLimit,
  gitHubSettings: GitHubSettings,
  gitHubTestResult: GitHubTestResult,
  buildName: BuildName,
  buildStage: BuildStage,
  buildState: BuildState,
  buildTrigger: BuildTrigger,
  buildJob: BuildJob,
  buildProgress: BuildProgress,
  buildResult: BuildResult,
  buildConfig: BuildConfig,
  buildSettings: BuildSettings,
  buildSettingsUpdate: BuildSettingsUpdate,
  agentBuildCache: AgentBuildCache,
  containerTier: ContainerTier,
  containerState: ContainerState,
  containerHealth: ContainerHealth,
  composeRef: ComposeRef,
  hostPort: HostPort,
  hostMount: HostMount,
  containerStats: ContainerStats,
  hostContainer: HostContainer,
  hostVolume: HostVolume,
  hostImage: HostImage,
  hostNetwork: HostNetwork,
  hostFilesystem: HostFilesystem,
  hostDisk: HostDisk,
  hostBuilderCache: HostBuilderCache,
  hostInventory: HostInventory,
  hostSample: HostSample,
  hostSnapshot: HostSnapshot,
  hostResponse: HostResponse,
  composeConfig: ComposeConfig,
  stackManifest: StackManifest,
  agentStack: AgentStack,
  lifecycleVerb: LifecycleVerb,
  actionTarget: ActionTarget,
  serviceName: ServiceName,
  containerId: ContainerId,
  actionState: ActionState,
  actionStatus: ActionStatus,
  actionPage: ActionPage,
  actionJob: ActionJob,
  actionProgress: ActionProgress,
  actionResult: ActionResult,
  actionRequest: ActionRequest,
  logsRequest: LogsRequest,
  logsSession: LogsSession,
  logsJob: LogsJob,
  logLine: LogLine,
  logsChunk: LogsChunk,
  logsChunkAck: LogsChunkAck,
  mcpAction: ShipyardActionInput,
  mcpLogs: ShipyardLogsInput,
  serviceConfig: ServiceConfig,
  backupStep: BackupStep,
  stackTrack: StackTrack,
  stackService: StackService,
  stackHealth: StackHealth,
  agentStackService: AgentStackService,
  stackUpdateJob: StackUpdateJob,
  stackUpdateStep: StackUpdateStep,
  stackUpdateProgress: StackUpdateProgress,
  stackUpdateResult: StackUpdateResult,
  stackUpdateState: StackUpdateState,
  stackUpdateStatus: StackUpdateStatus,
  stackUpdatePage: StackUpdatePage,
  stackUpdateRequest: StackUpdateRequest,
  stackRollbackRequest: StackRollbackRequest,
  mcpStackUpdate: ShipyardStackUpdateInput,
  volumeName: VolumeName,
  volumeOwner: VolumeOwner,
  volumeBackupSettings: VolumeBackupSettings,
  maintenanceJob: MaintenanceJob,
  volumeArchive: VolumeArchive,
  pruneItem: PruneItem,
  maintenanceStep: MaintenanceStep,
  maintenanceProgress: MaintenanceProgress,
  maintenanceResult: MaintenanceResult,
  maintenanceState: MaintenanceState,
  maintenanceStatus: MaintenanceStatus,
  maintenancePage: MaintenancePage,
  volumeBackupRequest: VolumeBackupRequest,
  volumeRestoreRequest: VolumeRestoreRequest,
  volumeDeleteRequest: VolumeDeleteRequest,
  pruneRequest: PruneRequest,
  mcpPrune: ShipyardPruneInput,
  mcpVolumeBackup: ShipyardVolumeBackupInput,
};

// Every exported value of ../src/index.js that is itself a Zod schema (as
// opposed to a helper function, a plain object such as MCP_TOOLS, or a type)
// must have a SCHEMAS entry with fixtures on disk — this is what stops the
// coverage gap from coming back.
const INDEX_SCHEMAS = (Object.entries(schemaExports) as [string, unknown][]).filter(
  (entry): entry is [string, ZodType] => entry[1] instanceof z.ZodType,
);
const SCHEMAS_BY_REFERENCE = new Set(Object.values(SCHEMAS));

function loadFixture(path: string): unknown {
  const text = readFileSync(path, 'utf-8');
  return path.endsWith('.yaml') || path.endsWith('.yml') ? parseYaml(text) : (JSON.parse(text) as unknown);
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

describe('fixtures', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const validDir = join(fixturesRoot, name, 'valid');
    const invalidDir = join(fixturesRoot, name, 'invalid');
    const validFiles = listFiles(validDir);
    const invalidFiles = listFiles(invalidDir);

    describe(name, () => {
      it('has at least one valid and two invalid fixtures', () => {
        expect(validFiles.length).toBeGreaterThanOrEqual(1);
        expect(invalidFiles.length).toBeGreaterThanOrEqual(2);
      });

      for (const file of validFiles) {
        it(`accepts ${file.slice(fixturesRoot.length)}`, () => {
          const data = loadFixture(file);
          const result = schema.safeParse(data);
          expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
        });
      }

      for (const file of invalidFiles) {
        it(`rejects ${file.slice(fixturesRoot.length)}`, () => {
          const data = loadFixture(file);
          const result = schema.safeParse(data);
          expect(result.success).toBe(false);
        });
      }
    });
  }
});

describe('fixture completeness', () => {
  it('covers every Zod schema exported from src/index.ts', () => {
    for (const [exportName, schema] of INDEX_SCHEMAS) {
      expect(SCHEMAS_BY_REFERENCE.has(schema), `no SCHEMAS entry references the export "${exportName}"`).toBe(true);
    }
  });

  for (const [name] of Object.entries(SCHEMAS)) {
    it(`${name} has at least one valid and two invalid fixture files on disk`, () => {
      const validFiles = listFiles(join(fixturesRoot, name, 'valid'));
      const invalidFiles = listFiles(join(fixturesRoot, name, 'invalid'));
      expect(validFiles.length, `${name}/valid`).toBeGreaterThanOrEqual(1);
      expect(invalidFiles.length, `${name}/invalid`).toBeGreaterThanOrEqual(2);
    });
  }
});
