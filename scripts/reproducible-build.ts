// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap fixes host process environment before invoking the Effect-based build.
import * as NodeChildProcess from "node:child_process";

const sourceDateEpoch = NodeChildProcess.execFileSync(
  "git",
  ["show", "-s", "--format=%ct", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();
const result = NodeChildProcess.spawnSync("vp", ["run", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    CI: "1",
    LANG: "C",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    TZ: "UTC",
  },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
