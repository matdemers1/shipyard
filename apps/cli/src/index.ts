#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { buildPorts } from './config.js';
import { main } from './main.js';

const code = await main(process.argv.slice(2), process.env, {
  buildPorts: (config) => buildPorts(config, process.stderr),
  deployId: () => randomUUID(),
  requesterLabel: () => `cli@${hostname()}`,
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = code;
