#!/usr/bin/env node
// Load (or reload) the combined sn_milo extension from this repo's root into a running browser over CDP.
// Runs the generation gate first; see scripts/dev-tools.mjs for the full flow and safety checks.
//   SN_MILO_CDP=http://127.0.0.1:<port> node scripts/load-extension.mjs --yes
import {run, isMain} from './dev-tools.mjs';
if (isMain(import.meta.url)) process.exitCode = (await run({reinject: false})).exitCode;
