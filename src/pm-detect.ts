import * as fs from 'fs-extra';
import * as path from 'path';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCK_FILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/**
 * Detect the package manager by walking up from startPath looking for lock files.
 * Returns 'npm' if nothing found.
 */
export function detectPackageManager(startPath: string): PackageManager {
  let dir = path.resolve(startPath);
  const root = path.parse(dir).root;

  while (true) {
    for (const [lockFile, pm] of LOCK_FILES) {
      if (fs.pathExistsSync(path.join(dir, lockFile))) {
        return pm;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      break;
    }
    dir = parent;
  }

  return 'npm';
}

/** Returns true if the package manager uses a symlink-based store (bun, pnpm). */
export function usesSymlinkStore(pm: PackageManager): boolean {
  return pm === 'bun' || pm === 'pnpm';
}
