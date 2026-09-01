#!/usr/bin/env node
import { cliLocale, formatCliFailure, runCli } from "./main.js";

const argv = process.argv.slice(2);
let locale: "en" | "zh-CN" = "en";
try {
  const localeIndex = argv.indexOf("--locale");
  locale = cliLocale(localeIndex < 0 ? undefined : argv[localeIndex + 1]);
  await runCli(argv);
} catch (error) {
  process.stderr.write(formatCliFailure(error, locale));
  process.exitCode = 1;
}
