// One entrypoint for independent, disposable server regression scenarios.
// Never inherit a database URL or third-party credential from the workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(testDirectory, "helpers", "local-network-only.cjs");
const suites = [
  ["auth, sessions, CSRF and message crypto", "auth-crypto-isolated.mjs"],
  ["restricted channels, claims and realtime", "claims-realtime-isolated.mjs"],
  ["time zones and rate limits", "time-rate-isolated.mjs"],
  ["private media and cache policy", "media-auth-isolated.mjs"],
  ["mocked VirusTotal consent and analysis", "virus-total-smoke-isolated.mjs"],
  ["stories and expiry", "stories-isolated.mjs"],
  ["custom status and emoji", "custom-status-isolated.mjs"],
  ...(process.env.REGRESSION_EXTENDED === "1"
    ? [["extended file-library and mock scanner coverage", "file-channel-isolated.mjs"]]
    : []),
];
const selectedSuites = process.env.REGRESSION_ONLY
  ? suites.filter(([, filename]) => filename.includes(process.env.REGRESSION_ONLY))
  : process.env.REGRESSION_REVERSE_ORDER === "1" ? [...suites].reverse() : suites;
if (selectedSuites.length === 0) throw new Error("REGRESSION_ONLY did not match a regression suite.");

if (process.env.REGRESSION_DATABASE_URL || process.env.TEST_DATABASE_URL) {
  throw new Error("Refusing a supplied test database URL: regression databases must be created in /tmp by each isolated suite.");
}
if (process.env.RUN_LIVE_VT) {
  throw new Error("Refusing live VirusTotal mode in the regression suite.");
}

function isolatedEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PG|DATABASE|REPLIT_DB|EXTERNAL_DATABASE|PROD_DATABASE|GIPHY|VIRUSTOTAL|SESSION_SECRET|MESSAGE_ENCRYPTION_KEY|APP_URL|NODE_OPTIONS|PORT$)/i.test(key)) {
      delete env[key];
    }
  }
  // A script that forgets to construct and pass its own disposable URL must
  // fail at a closed loopback port, rather than silently using development.
  env.DATABASE_URL = "postgresql://regression_guard@127.0.0.1:1/no_database";
  env.REGRESSION_SUITE = "1";
  env.RUN_LIVE_VT = "0";
  env.NODE_OPTIONS = `--require=${guard}`;
  return env;
}

async function runSuite(filename) {
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(testDirectory, filename)], {
    cwd: path.resolve(testDirectory, "../../.."),
    env: isolatedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      output.push(chunk);
      if (output.join("").length > 2_000_000) {
        child.kill("SIGTERM");
      }
    });
  }
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const text = output.join("");
  assert.equal(code, 0, `${filename} exited ${code ?? signal}\n${text.slice(-12_000)}`);
  return {
    elapsed: ((performance.now() - started) / 1000).toFixed(1),
    checks: text.split("\n").filter(line => line.startsWith("PASS ")).length,
  };
}

test("server regression suite (fresh migrated PostgreSQL per scenario)", {
  concurrency: 2,
  // The full run includes multiple isolated migrations and bundled API starts.
  timeout: 240_000,
}, async t => {
  await Promise.all(selectedSuites.map(([name, filename]) =>
    t.test(name, { timeout: 130_000 }, async t => {
      const result = await runSuite(filename);
      t.diagnostic(`${result.checks} observable checks; ${result.elapsed}s; disposable database removed`);
    })
  ));
});