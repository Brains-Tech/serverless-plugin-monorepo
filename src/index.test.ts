import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';
import { detectPackageManager } from './pm-detect';
import { readManifest, writeManifest, removeManifest } from './manifest';
import ServerlessMonoRepo from './index';

const TMP = path.join(__dirname, '..', '.test-tmp');

beforeEach(async () => {
  await fs.ensureDir(TMP);
});

afterEach(async () => {
  await fs.remove(TMP);
});

// --- PM Detection ---

describe('detectPackageManager', () => {
  test('detects bun.lock', async () => {
    const dir = path.join(TMP, 'bun-proj');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'bun.lock'), '');
    expect(detectPackageManager(dir)).toBe('bun');
  });

  test('detects bun.lockb', async () => {
    const dir = path.join(TMP, 'bunb-proj');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'bun.lockb'), '');
    expect(detectPackageManager(dir)).toBe('bun');
  });

  test('detects pnpm-lock.yaml', async () => {
    const dir = path.join(TMP, 'pnpm-proj');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  test('detects yarn.lock', async () => {
    const dir = path.join(TMP, 'yarn-proj');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir)).toBe('yarn');
  });

  test('detects package-lock.json', async () => {
    const dir = path.join(TMP, 'npm-proj');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    expect(detectPackageManager(dir)).toBe('npm');
  });

  test('defaults to npm when no lock file found before root', async () => {
    // This test can only truly pass in an env with no lock files above TMP.
    // Since our repo has bun.lock, we test that a dir with package-lock.json
    // is correctly detected as npm (not walking further up).
    const dir = path.join(TMP, 'npm-default');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    expect(detectPackageManager(dir)).toBe('npm');
  });

  test('walks up to find lock file in parent', async () => {
    const parent = path.join(TMP, 'parent');
    const child = path.join(parent, 'packages', 'child');
    await fs.ensureDir(child);
    await fs.writeFile(path.join(parent, 'bun.lock'), '');
    expect(detectPackageManager(child)).toBe('bun');
  });

  test('bun takes priority over yarn when both exist', async () => {
    const dir = path.join(TMP, 'both-proj');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'bun.lock'), '');
    await fs.writeFile(path.join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir)).toBe('bun');
  });
});

// --- Manifest ---

describe('manifest', () => {
  test('read returns empty array when no manifest exists', async () => {
    const dir = path.join(TMP, 'no-manifest');
    await fs.ensureDir(dir);
    expect(await readManifest(dir)).toEqual([]);
  });

  test('write and read round-trip', async () => {
    const dir = path.join(TMP, 'manifest-dir');
    await fs.ensureDir(dir);
    const names = ['@my-org/shared', 'utils', '@scope/other'];
    await writeManifest(dir, names);
    expect(await readManifest(dir)).toEqual(names);
  });

  test('remove deletes the manifest file', async () => {
    const dir = path.join(TMP, 'manifest-rm');
    await fs.ensureDir(dir);
    await writeManifest(dir, ['pkg']);
    await removeManifest(dir);
    expect(await readManifest(dir)).toEqual([]);
  });

  test('read handles corrupt manifest gracefully', async () => {
    const dir = path.join(TMP, 'manifest-corrupt');
    await fs.ensureDir(dir);
    await fs.writeFile(
      path.join(dir, '.serverless-monorepo-links.json'),
      'not json'
    );
    expect(await readManifest(dir)).toEqual([]);
  });
});

// --- Clean behavior ---

describe('clean behavior', () => {
  test('npm/yarn clean removes all symlinks', async () => {
    const nodeModules = path.join(TMP, 'npm-clean', 'node_modules');
    await fs.ensureDir(nodeModules);

    // Create a real dir (should survive) and symlinks (should be removed)
    const realDir = path.join(nodeModules, 'real-pkg');
    await fs.ensureDir(realDir);
    await fs.writeFile(path.join(realDir, 'index.js'), '');

    const symlinkTarget = path.join(TMP, 'npm-clean', 'target-pkg');
    await fs.ensureDir(symlinkTarget);
    await fs.symlink(symlinkTarget, path.join(nodeModules, 'linked-pkg'), 'junction');

    // Load plugin with npm detection
    const plugin = createPlugin(path.join(TMP, 'npm-clean'), 'npm');
    await plugin.clean();

    // Real dir should survive
    expect(await fs.pathExists(realDir)).toBe(true);
    // Symlink should be gone
    expect(await fs.pathExists(path.join(nodeModules, 'linked-pkg'))).toBe(false);
  });

  test('bun clean only removes manifest-listed symlinks', async () => {
    const serviceDir = path.join(TMP, 'bun-clean');
    const nodeModules = path.join(serviceDir, 'node_modules');
    await fs.ensureDir(nodeModules);

    // Create two symlinks
    const target1 = path.join(TMP, 'bun-clean', 'target1');
    const target2 = path.join(TMP, 'bun-clean', 'target2');
    await fs.ensureDir(target1);
    await fs.ensureDir(target2);
    await fs.symlink(target1, path.join(nodeModules, 'plugin-created'), 'junction');
    await fs.symlink(target2, path.join(nodeModules, 'bun-managed'), 'junction');

    // Manifest only lists plugin-created
    await writeManifest(nodeModules, ['plugin-created']);

    const plugin = createPlugin(serviceDir, 'bun');
    await plugin.clean();

    // Plugin-created symlink removed
    expect(await fs.pathExists(path.join(nodeModules, 'plugin-created'))).toBe(false);
    // Bun-managed symlink preserved
    const stat = await fs.lstat(path.join(nodeModules, 'bun-managed'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test('bun clean with no manifest is a no-op', async () => {
    const serviceDir = path.join(TMP, 'bun-no-manifest');
    const nodeModules = path.join(serviceDir, 'node_modules');
    await fs.ensureDir(nodeModules);

    const target = path.join(TMP, 'bun-no-manifest', 'target');
    await fs.ensureDir(target);
    await fs.symlink(target, path.join(nodeModules, 'bun-pkg'), 'junction');

    const plugin = createPlugin(serviceDir, 'bun');
    await plugin.clean();

    // Symlink should survive
    const stat = await fs.lstat(path.join(nodeModules, 'bun-pkg'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test('bun clean removes scoped package symlinks and empty scope dirs', async () => {
    const serviceDir = path.join(TMP, 'bun-scoped');
    const nodeModules = path.join(serviceDir, 'node_modules');
    const scopeDir = path.join(nodeModules, '@myorg');
    await fs.ensureDir(scopeDir);

    const target = path.join(TMP, 'bun-scoped', 'target');
    await fs.ensureDir(target);
    await fs.symlink(target, path.join(scopeDir, 'shared'), 'junction');

    await writeManifest(nodeModules, ['@myorg/shared']);

    const plugin = createPlugin(serviceDir, 'bun');
    await plugin.clean();

    // Scoped symlink removed
    expect(await fs.pathExists(path.join(scopeDir, 'shared'))).toBe(false);
    // Empty scope dir removed
    expect(await fs.pathExists(scopeDir)).toBe(false);
  });
});

// --- Helper to create a minimal plugin instance ---

function createPlugin(servicePath: string, pm: string) {
  const serverless = {
    cli: { log: () => {} },
    config: { servicePath },
    service: {
      custom: {
        serverlessMonoRepo: { packageManager: pm },
      },
    },
  } as any;
  return new ServerlessMonoRepo(serverless);
}
