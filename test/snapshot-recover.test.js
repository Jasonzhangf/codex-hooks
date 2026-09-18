import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "src", "rccs-recover.sh");

test("rccs-recover backs up binaries, config, provider, secrets, and aliases", async () => {
  const home = await mkdtemp(join(tmpdir(), "rccs-recover-backup-"));
  try {
    const fixture = await createFixture(home);
    const result = await run("/bin/sh", [script, "backup", "--id", "snap-1"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /snapshot=snap-1/);

    const snapshot = join(fixture.snapshotRoot, "snap-1");
    assert.match(await readFile(join(snapshot, "bin", "rccv3"), "utf8"), /rccv3 test/);
    assert.equal(await readFile(join(snapshot, "config", "config.toml"), "utf8"), "config-v1\n");
    assert.equal(await readFile(join(snapshot, "config", "provider", "p1", "config.v2.toml"), "utf8"), "provider-v1\n");
    assert.equal(await readFile(join(snapshot, "config", "secrets", "v3", "key"), "utf8"), "secret-v1\n");
    assert.equal(await readFile(join(snapshot, "aliases", "rcc"), "utf8"), "rccv3\n");
    assert.equal(await readFile(join(snapshot, "aliases", "routecodex"), "utf8"), "rccv3\n");
    assert.match(await readFile(join(snapshot, "manifest.sha256"), "utf8"), /bin\/rccv3/);

    const listed = await run("/bin/sh", [script, "list"], { HOME: home });
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout, "snap-1 latest\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rccs-recover restores files and invokes only managed rccv3 lifecycle commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "rccs-recover-restore-"));
  try {
    const fixture = await createFixture(home);
    assert.equal((await run("/bin/sh", [script, "backup", "--id", "snap-1"], { HOME: home })).code, 0);
    await writeFile(join(fixture.binDir, "rccv3"), "broken\n");
    await chmod(join(fixture.binDir, "rccv3"), 0o755);
    await writeFile(join(fixture.rccHome, "config.toml"), "config-broken\n");
    await writeFile(join(fixture.rccHome, "provider", "p1", "config.v2.toml"), "provider-broken\n");
    await writeFile(join(fixture.rccHome, "secrets", "v3", "key"), "secret-broken\n");
    await rm(join(fixture.binDir, "rcc"));
    await symlink("wrong", join(fixture.binDir, "rcc"));

    const result = await run("/bin/sh", [script, "restore", "snap-1"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(join(fixture.binDir, "rccv3"), "utf8"), /rccv3 test/);
    assert.equal(await readFile(join(fixture.rccHome, "config.toml"), "utf8"), "config-v1\n");
    assert.equal(await readFile(join(fixture.rccHome, "provider", "p1", "config.v2.toml"), "utf8"), "provider-v1\n");
    assert.equal(await readFile(join(fixture.rccHome, "secrets", "v3", "key"), "utf8"), "secret-v1\n");
    assert.equal((await run("/bin/sh", ["-c", `readlink "${join(fixture.binDir, "rcc")}"`])).stdout, "rccv3\n");
    const log = await readFile(fixture.logPath, "utf8");
    assert.match(log, /config check -c .*\/snap-1\/config\/config.toml/);
    assert.match(log, /config check -c .*\/config.toml/);
    assert.match(log, /restart -c .*\/config.toml/);
    assert.match(log, /status -c .*\/config.toml/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rccs-recover rejects a tampered snapshot before changing live files", async () => {
  const home = await mkdtemp(join(tmpdir(), "rccs-recover-hash-"));
  try {
    const fixture = await createFixture(home);
    assert.equal((await run("/bin/sh", [script, "backup", "--id", "snap-1"], { HOME: home })).code, 0);
    await writeFile(join(fixture.rccHome, "config.toml"), "live-after-backup\n");
    await writeFile(join(fixture.snapshotRoot, "snap-1", "config", "config.toml"), "tampered\n");

    const result = await run("/bin/sh", [script, "restore", "snap-1"], { HOME: home });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /snapshot hash verification failed/);
    assert.equal(await readFile(join(fixture.rccHome, "config.toml"), "utf8"), "live-after-backup\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rccs-recover rejects a snapshot whose config check fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "rccs-recover-check-"));
  try {
    const fixture = await createFixture(home);
    assert.equal((await run("/bin/sh", [script, "backup", "--id", "snap-1"], { HOME: home })).code, 0);
    await writeFile(join(fixture.rccHome, "config.toml"), "live-after-backup\n");

    const result = await run("/bin/sh", [script, "restore", "snap-1"], {
      HOME: home,
      FAIL_CONFIG_CHECK: "1",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /snapshot config check failed/);
    assert.equal(await readFile(join(fixture.rccHome, "config.toml"), "utf8"), "live-after-backup\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rccs-recover rollback removes paths that did not exist before restore", async () => {
  const home = await mkdtemp(join(tmpdir(), "rccs-recover-rollback-"));
  try {
    const fixture = await createFixture(home);
    assert.equal((await run("/bin/sh", [script, "backup", "--id", "snap-1"], { HOME: home })).code, 0);
    await rm(join(fixture.rccHome, "provider"), { recursive: true });
    await rm(join(fixture.rccHome, "secrets"), { recursive: true });
    await rm(join(fixture.binDir, "rcc"));
    await rm(join(fixture.binDir, "routecodex"));
    await rm(join(fixture.binDir, "rccv3-admin"));

    const result = await run("/bin/sh", [script, "restore", "snap-1"], {
      HOME: home,
      FAIL_LIVE_CONFIG_CHECK: "1",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /restored config check failed/);
    assert.equal(await pathExists(join(fixture.rccHome, "provider")), false);
    assert.equal(await pathExists(join(fixture.rccHome, "secrets")), false);
    assert.equal(await pathExists(join(fixture.binDir, "rcc")), false);
    assert.equal(await pathExists(join(fixture.binDir, "routecodex")), false);
    assert.equal(await pathExists(join(fixture.binDir, "rccv3-admin")), false);
    assert.equal(await readFile(join(fixture.rccHome, "config.toml"), "utf8"), "config-v1\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rccs-recover does not require Node on PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "rccs-recover-no-node-"));
  try {
    await createFixture(home);
    const result = await run("/bin/sh", [script, "backup", "--id", "snap-1"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
    });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function createFixture(home) {
  const binDir = join(home, ".local", "bin");
  const rccHome = join(home, ".rcc");
  const snapshotRoot = join(rccHome, "state", "backups", "rcc-snapshots");
  const logPath = join(home, "rccv3.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(rccHome, "provider", "p1"), { recursive: true });
  await mkdir(join(rccHome, "secrets", "v3"), { recursive: true });
  const fakeRccv3 = `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
if [ "\${FAIL_CONFIG_CHECK:-}" = 1 ] && [ "$1" = config ] && [ "$2" = check ]; then
  exit 1
fi
if [ "\${FAIL_LIVE_CONFIG_CHECK:-}" = 1 ] && [ "$1" = config ] && [ "$2" = check ]; then
  case "$*" in
    */.rcc/config.toml) exit 1 ;;
  esac
fi
if [ "$1" = --version ]; then
  printf 'rccv3 test\\n'
  exit 0
fi
if [ "$1" = config ] || [ "$1" = restart ] || [ "$1" = status ]; then
  exit 0
fi
exit 0
`;
  for (const name of ["rccv3", "rccv3-admin", "rccv3-hooksd", "rccv3-codexapp"]) {
    await writeFile(join(binDir, name), name === "rccv3" ? fakeRccv3 : `${name}\n`);
    await chmod(join(binDir, name), 0o755);
  }
  await symlink("rccv3", join(binDir, "rcc"));
  await symlink("rccv3", join(binDir, "routecodex"));
  await writeFile(join(rccHome, "config.toml"), "config-v1\n");
  await writeFile(join(rccHome, "provider", "p1", "config.v2.toml"), "provider-v1\n");
  await writeFile(join(rccHome, "secrets", "v3", "key"), "secret-v1\n");
  return { binDir, rccHome, snapshotRoot, logPath };
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
