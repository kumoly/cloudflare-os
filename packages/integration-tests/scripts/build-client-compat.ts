// Build the frozen client and a pinned Workshop release, independently of candidate source.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmCommand } from "@gadgets/scripts/pnpm-command";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = join(root, "packages/integration-tests");
const client = join(pkg, "fixtures/openclaw-client");
// The first release with openWorkspace; never move forward merely to make a regression green.
const baseline = "539fafa8e99951e134f8c9a47fdb4ff9dd2e61e2";
const out = join(pkg, ".wrangler/client-upgrade-base");
function run(cmd: string, args: string[], cwd: string) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", timeout: 600_000 });
}
function pnpm(args: string[], cwd: string) {
  const [cmd, argv] = pnpmCommand(args); run(cmd, argv, cwd);
}
const provenance = JSON.parse(readFileSync(join(client, "provenance.json"), "utf8")) as {
  filesSha256: Record<string, string>;
};
for (const [file, expected] of Object.entries(provenance.filesSha256)) {
  if (createHash("sha256").update(readFileSync(join(client, file))).digest("hex") !== expected) {
    throw new Error(`Published client changed: ${file}`);
  }
}
pnpm(["install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"], client);
const fingerprint = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
const marker = join(out, "built-by");
if (!existsSync(marker) || readFileSync(marker, "utf8") !== fingerprint) {
  try { execFileSync("git", ["cat-file", "-e", `${baseline}^{commit}`], { cwd: root, stdio: "ignore" }); }
  catch { run("git", ["fetch", "--depth=1", "origin", baseline], root); }
  const tree = mkdtempSync(join(tmpdir(), "cfos-client-base-"));
  run("git", ["worktree", "add", "--detach", tree, baseline], root);
  try {
    pnpm(["install", "--frozen-lockfile", "--prefer-offline"], tree);
    pnpm(["exec", "vp", "run", "-F", "@gadgets/workshop-backend", "build:integration-worker"], tree);
    rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
    pnpm(["exec", "wrangler", "deploy", "--dry-run", "--outdir", join(out, "bundle")], join(tree, "packages/workshop-backend"));
    writeFileSync(marker, fingerprint);
  } finally { run("git", ["worktree", "remove", "--force", tree], root); }
}
