import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BuildState, DeployTargetState, Gate, GATE_DESCRIPTIONS } from '@shipyard/schema';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  BUILD_STATE_WORDS,
  CHECK_NAMES,
  DEPLOY_STATE_WORDS,
  STATUS_WORDS,
  approveVerb,
  checkName,
  ciWords,
  deployAllReadyVerb,
  deployVerb,
  rollBackVerb,
  stateWords,
} from '../src/lib/words';

/**
 * SHP-T-13.3 (SHP-REQ-165, SHP-REQ-171): one vocabulary. The words module is the only place a
 * state label, verb or check name is spelled, and this guards it three ways: no retired label
 * survives in the console's source, every gate and deploy state has words, and the console's check
 * names are the schema's.
 */

const SRC = join(__dirname, '..', 'src');
const SHA = '2cd9c27' + 'f'.repeat(33);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every piece of text a person could read in a file: string and template literals and JSX text.
 * Parsed rather than grepped, so a comment explaining why "Ship" was retired does not trip it.
 */
function literals(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text);
    } else if (ts.isJsxText(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Labels the approved design retired (SHP-ADR-006): the primary names the SHA, so never "Ship" or
 * a bare "Confirm"; "Roll all" became "Deploy all ready". "Confirm agent" and "Confirm password"
 * are other flows' words and stay; only the bare label is forbidden.
 */
const FORBIDDEN: { name: string; test: (text: string) => boolean }[] = [
  { name: 'Ship (as a label)', test: (t) => /\bShip(s|ped|ping)?\b/.test(t) },
  { name: 'ship (as a verb)', test: (t) => /\bship(s|ped|ping|pable)?\b/.test(t) },
  { name: 'Roll all', test: (t) => /\broll all\b/i.test(t) },
  { name: 'Ready to ship', test: (t) => /\bready to ship\b/i.test(t) },
  { name: 'Confirm (as a whole label)', test: (t) => t.trim() === 'Confirm' },
  // An in-flight deploy is named by its state ("Pulling", "Soaking"), never a blanket "Active".
  { name: 'Active (as a whole label)', test: (t) => t.trim() === 'Active' },
  // A person reads "checks"; the gate code (G5) is only ever secondary text (SHP-REQ-171).
  { name: 'gate (as a word)', test: (t) => /\bgates?\b/i.test(t) },
];


describe('the console speaks one vocabulary (SHP-REQ-165)', () => {
  const files = sourceFiles(SRC);

  it('finds the console source to scan', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(FORBIDDEN)('no string or JSX text in apps/web/src says $name', ({ test }) => {
    const hits = files
      .flatMap((file) =>
      literals(file)
        .filter(test)
        .map((text) => `${relative(SRC, file)}: ${JSON.stringify(text.trim().slice(0, 80))}`),
    );
    expect(hits).toEqual([]);
  });
});

describe('every state and gate has words (SHP-REQ-165, SHP-REQ-171)', () => {
  it('has a label for every deploy state the schema defines', () => {
    for (const state of DeployTargetState.options) {
      expect(DEPLOY_STATE_WORDS[state], state).toBeTruthy();
      expect(stateWords(state)).toBe(DEPLOY_STATE_WORDS[state]);
    }
    expect(Object.keys(DEPLOY_STATE_WORDS).sort()).toEqual([...DeployTargetState.options].sort());
  });

  it('names the in-flight states by step and the finished ones by outcome, not one "Active"', () => {
    expect(stateWords('awaiting_approval')).toBe('Waiting for approval');
    expect(stateWords('soaking')).toBe('Soaking');
    expect(stateWords('rolled_back')).toBe('Rolled back');
    expect(stateWords('refused')).toBe('Refused');
    expect(Object.values(DEPLOY_STATE_WORDS)).not.toContain('Active');
  });

  it('falls back to readable words for a state a newer server adds', () => {
    expect(stateWords('mystery_state')).toBe('mystery state');
  });

  it('has a label for every build state the schema defines', () => {
    for (const state of BuildState.options) {
      expect(BUILD_STATE_WORDS[state], state).toBeTruthy();
    }
  });

  it('has a human name for every gate', () => {
    for (const gate of Gate.options) {
      expect(checkName(gate), gate).not.toBe('');
      expect(checkName(gate), gate).not.toBe(gate);
    }
  });

  it("matches the schema's GATE_DESCRIPTIONS, which the console mirrors", () => {
    expect(CHECK_NAMES).toEqual(GATE_DESCRIPTIONS);
  });

  it('names a check by its human name, disk included', () => {
    expect(checkName('G5')).toBe('CI passed');
    expect(checkName('G8')).toBe('Images in GHCR');
    expect(checkName('G10')).toBe('No contract release since');
    expect(checkName('disk')).toBe('Disk has space');
    expect(checkName('G6')).toBe('On the default branch');
    expect(checkName('G6', { branch: 'main' })).toBe('On main');
    expect(checkName('G6', { branch: null })).toBe('On the default branch');
    expect(checkName('G99')).toBe('G99');
  });
});

describe('the verbs name what they do', () => {
  it('names the SHA on every primary, never Ship, Confirm or a bare Roll', () => {
    expect(deployVerb(SHA)).toBe('Deploy 2cd9c27');
    expect(rollBackVerb(SHA)).toBe('Roll back to 2cd9c27');
    expect(approveVerb(SHA)).toBe('Approve and deploy 2cd9c27');
    expect(deployAllReadyVerb(5)).toBe('Deploy all ready (5)');
  });

  it('words the app and commit states with the shared vocabulary', () => {
    expect(STATUS_WORDS.ready).toBe('Ready');
    expect(STATUS_WORDS.waiting).toBe('Waiting');
    expect(ciWords('success')).toBe('CI passed');
    expect(ciWords('failure')).toBe('CI failed');
    expect(ciWords('pending')).toBe('CI running');
    expect(ciWords('none')).toBe('No images');
    expect(ciWords('success', 'shipyard')).toBe('Built');
  });
});

describe('a check is never named by its gate code alone (SHP-REQ-171)', () => {
  it('no template in apps/web/src puts a bare `.gate` in front of the words people read', () => {
    // checkName() and <CheckName> are the only places allowed to turn a gate into words.
    const allowed = new Set([join('lib', 'words.ts'), join('components', 'CheckName.tsx')]);
    const hits = sourceFiles(SRC)
      .filter((file) => !allowed.has(relative(SRC, file)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(SRC, file)}:${String(i + 1)}` }))
          .filter(({ line }) => /\$\{[\w.?]*\.gate\}\s*(failed|passed|refused)/.test(line))
          .map(({ at }) => at),
      );
    expect(hits).toEqual([]);
  });
});
