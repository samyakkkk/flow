#!/usr/bin/env node
import { main } from "./instances/launcher.mjs";
main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
