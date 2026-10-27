/**
 * Boot rehearsal — runs the REAL deployed dsh-app-boot profile loader against
 * this machine's live profile directory and proves this bundle composes.
 *
 * Why this exists: on dsh 0.2.0-rc.1 the plugin "did not load" with no error
 * anywhere in the UI — `loadProfileDirectory` silently moves an incompatible or
 * unreadable bundle into `skippedBundles`, so the mount row never reaches the
 * composed entry list and nothing mounts at boot. This script replays exactly
 * the boot-time steps (bundle resolution → compatibility gate → patch layer →
 * `composeEntries` over an empty root) and fails loudly if:
 *
 *   1. the bundle is missing from the profile's `dsh.profile.bundles`, or
 *   2. `loadProfileDirectory` skips it (compat gate / unreadable manifest), or
 *   3. the composed entry list has no `token-stats` row, or
 *   4. the Host half cannot be imported through the profile's own link
 *      (broken junction / missing exports entry).
 *
 * Resolution order for @deepseek-ai/dsh-app-boot (see AGENTS.md):
 *   1. bare import — works when the workspace has the usual junctions
 *   2. DSH_NODE_MODULES=<path to the DSH deployment's node_modules>
 *
 * The profile directory comes from DSH_PROFILE_DIR (set in every profile-
 * launched Harness shell); without it the script reports SKIP and exits 0, so
 * CI runs without a profile stay green.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE_NAME = "@duke-dsh-plugins/dsh-token-stats";

let failures = 0;
function check(label, cond, detail = "") {
  console.log((cond ? "  ok  " : "  FAIL") + " " + label + (cond || !detail ? "" : " — " + detail));
  if (!cond) failures++;
}

async function importAppBoot() {
  try {
    return await import("@deepseek-ai/dsh-app-boot");
  } catch {
    // fall through to explicit locations
  }
  const candidates = [];
  if (process.env.DSH_NODE_MODULES) {
    candidates.push(join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh-app-boot", "lib", "index.js"));
  }
  candidates.push(join(pkgRoot, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js"));
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (hit === undefined) return undefined;
  return import(pathToFileURL(hit).href);
}

const appBoot = await importAppBoot();
if (appBoot === undefined || typeof appBoot.loadProfileDirectory !== "function") {
  console.error("repro:profile-boot — cannot import loadProfileDirectory from @deepseek-ai/dsh-app-boot.");
  console.error("Junction the DSH deployment's @deepseek-ai/* into ./node_modules (see AGENTS.md)");
  console.error("or set DSH_NODE_MODULES to the deployment's node_modules.");
  process.exit(1);
}

const profileDir = process.env.DSH_PROFILE_DIR;
if (!profileDir || !existsSync(join(profileDir, "package.json"))) {
  console.log("repro:profile-boot — SKIP: no profile directory (set DSH_PROFILE_DIR to rehearse a boot).");
  process.exit(0);
}

// installAnchor: the deployment's own package.json. The workspace junction
// node_modules/@deepseek-ai points at the deployment's @deepseek-ai directory,
// so its parent is the deployment's node_modules.
const anchorCandidates = [];
if (process.env.DSH_NODE_MODULES) anchorCandidates.push(join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh", "package.json"));
const workspaceScope = join(pkgRoot, "node_modules", "@deepseek-ai");
if (existsSync(workspaceScope)) {
  try {
    anchorCandidates.push(join(dirname(realpathSync(workspaceScope)), "@deepseek-ai", "dsh", "package.json"));
  } catch { /* unreachable link — fall through */ }
}
const installAnchor = anchorCandidates.find((candidate) => existsSync(candidate));
if (installAnchor === undefined) {
  console.error("repro:profile-boot — FAIL: cannot locate the DSH deployment's package.json (install anchor).");
  process.exit(1);
}

// 1. the profile must list the bundle.
const manifest = JSON.parse(await import("node:fs").then((fs) => fs.promises.readFile(join(profileDir, "package.json"), "utf8")));
const bundles = manifest.dsh?.profile?.bundles ?? [];
check("profile lists the bundle in dsh.profile.bundles", bundles.includes(BUNDLE_NAME), JSON.stringify(bundles));
if (!bundles.includes(BUNDLE_NAME)) {
  console.log("\nRun: dsh plugin --profile " + manifest.name?.replace(/^dsh-profile-/, "") + " add " + pkgRoot);
  process.exit(1);
}

// 2. real profile load — nothing may land in skippedBundles.
const profile = appBoot.loadProfileDirectory("dsh", profileDir, installAnchor);
const ours = profile.skippedBundles.filter((entry) => entry.packageName === BUNDLE_NAME);
check("boot loader does not skip the bundle", ours.length === 0, JSON.stringify(profile.skippedBundles));
check("bundle resolves from the profile link", profile.layers.some((layer) => layer.packageName === BUNDLE_NAME));

// 3. composed entry list — the mount row must survive composition.
const layerPatches = profile.layers.map((layer) => layer.patches);
const composed = appBoot.composeEntries([...layerPatches, profile.patches]);
const row = (composed ?? []).find((entry) => entry && entry.id === "token-stats");
check("composed entries contain the token-stats row", row !== undefined, JSON.stringify((composed ?? []).map((entry) => entry?.id)));
check("row mounts this package", row?.name === BUNDLE_NAME, JSON.stringify(row));

// 4. the Host half must be loadable through the profile's own copy.
//    link: 安装时 realpath 落回本仓库，裸 import 借工作区 junction 解析 peer；
//    npm 安装时 realpath 在 profile node_modules 里，@deepseek-ai peer 不在
//    profile 内（pnpm 隔离，peer missing 是常态），裸 Node 解析不到——真实
//    宿主由 0.1.7+ 的内存路由表 + ESM/CJS 拦截把 peer 路由到 DSH 安装副本
//    （AGENTS.md 0.1.7 节）。此时退而验证：Host 半声明的每个 @deepseek-ai
//    peer 都能在部署 node_modules（install anchor 所在目录）里找到。
const linkedIndex = join(profileDir, "node_modules", "@duke-dsh-plugins", "dsh-token-stats", "index.js");
check("profile link exposes index.js", existsSync(linkedIndex));
const realIndex = realpathSync(linkedIndex);
const insideProfile = realIndex.startsWith(realpathSync(join(profileDir, "node_modules")));
let hostHalf = null;
try {
  hostHalf = await import(pathToFileURL(realIndex).href);
  check("Host half imports through the profile link", true);
} catch (error) {
  if (!insideProfile) {
    check("Host half imports through the profile link", false, String(error));
  } else {
    const pkgJson = JSON.parse(readFileSync(join(dirname(realIndex), "package.json"), "utf8"));
    const deployNodeModules = dirname(dirname(dirname(installAnchor))); // anchor = <nm>/@deepseek-ai/dsh/package.json
    const wanted = Object.keys(pkgJson.peerDependencies || {}).filter((n) => n.startsWith("@deepseek-ai/"));
    const missing = wanted.filter((n) => !existsSync(join(deployNodeModules, ...n.split("/"))));
    check(
      "Host half peers resolve from the DSH deployment (npm install → runtime peer routing)",
      missing.length === 0,
      missing.length ? "deployment node_modules missing: " + missing.join(", ") : String((error && error.message) || error),
    );
  }
}
if (hostHalf) {
  check("Host half exports the TokenStatsService class", typeof hostHalf.TokenStatsService === "function");
}

console.log(failures === 0 ? "\nrepro:profile-boot — ALL PASS" : `\nrepro:profile-boot — ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
