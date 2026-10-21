#!/usr/bin/env node
// Developer update: gate → (re)load the combined extension → verify the loaded version → reinject into open tabs
// via the extension's own worker (snMilo.reinjectOpenTabs, shared/reinject.mjs). Never reloads/navigates tabs and
// never clicks or submits. See scripts/dev-tools.mjs.
//   SN_MILO_CDP=http://127.0.0.1:<port> node scripts/apply-update.mjs --yes
import {run, isMain} from './dev-tools.mjs';
if (isMain(import.meta.url)) process.exitCode = (await run({reinject: true})).exitCode;
