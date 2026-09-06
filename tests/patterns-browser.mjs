import { spawn } from "node:child_process";
const root = process.env.TEST_OUTPUT || "tests/results/patterns";
for (const fixture of [
  "mixed-layout",
  "varied-layout-1",
  "varied-layout-2",
  "varied-layout-3",
]) {
  const child = spawn(process.execPath, ["tests/mixed-browser.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      MIXED_FIXTURE: fixture,
      TEST_OUTPUT: `${root}/${fixture}`,
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
