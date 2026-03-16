import * as fs from 'fs-extra';
import * as path from 'path';
import Serverless from 'serverless';
import {
  PackageManager,
  detectPackageManager,
  usesSymlinkStore,
} from './pm-detect';
import { readManifest, writeManifest, removeManifest } from './manifest';

/** Takes a path and returns all node_modules resolution paths (but not global include paths). */
function getNodeModulePaths(p: string): string[] {
  const result: string[] = [];
  const paths = p.split(path.sep);
  while (paths.length) {
    result.push(path.join(paths.join(path.sep) || path.sep, 'node_modules'));
    paths.pop();
  }
  return result;
}

/** Creates a symlink. Ignore errors if symlink exists or package exists. */
async function link(target: string, f: string, type: fs.SymlinkType) {
  await fs.ensureDir(path.dirname(f));
  await fs.symlink(target, f, type).catch((e) => {
    if (e.code === 'EEXIST' || e.code === 'EISDIR') {
      return;
    }
    throw e;
  });
}

/** Settings that can be specified in serverless YAML file */
export interface ServerlessMonoRepoSettings {
  path: string;
  linkType: fs.SymlinkType;
  packageManager?: PackageManager;
}

/** Plugin implementation */
class ServerlessMonoRepo {
  settings: ServerlessMonoRepoSettings;
  hooks: { [key: string]: () => void };
  packageManager: PackageManager;

  constructor(private serverless: Serverless) {
    this.hooks = {
      'package:cleanup': () => this.clean(),
      'package:initialize': () => this.initialise(),
      'before:offline:start:init': () => this.initialise(),
      'offline:start': () => this.initialise(),
      'deploy:function:initialize': async () => {
        await this.clean();
        await this.initialise();
      },
    };

    // Settings
    const custom: Partial<ServerlessMonoRepoSettings> =
      this.serverless.service.custom?.serverlessMonoRepo ?? {};
    this.settings = {
      path: custom.path ?? this.serverless.config.servicePath,
      linkType: custom.linkType ?? 'junction',
    };

    // Detect package manager (setting override takes priority)
    this.packageManager =
      custom.packageManager ?? detectPackageManager(this.settings.path);
    this.log(`Detected package manager: ${this.packageManager}`);
  }

  log(msg: string) {
    this.serverless.cli.log(msg);
  }

  async linkPackage(
    name: string,
    fromPath: string,
    toPath: string,
    created: Set<string>,
    resolved: string[]
  ) {
    // Ignore circular dependencies
    if (resolved.includes(name)) {
      return;
    }

    // Obtain list of module resolution paths to use for resolving modules
    const paths = getNodeModulePaths(fromPath);

    // Get package file path
    const pkg = require.resolve('./' + path.join(name, 'package.json'), {
      paths,
    });

    // Get relative path to package & create link if not an embedded node_modules.
    // For bun/pnpm, the resolved path may go through .bun/ or .pnpm/ store which
    // contains extra node_modules segments — count only real node_modules dirs.
    const target = path.relative(
      path.join(toPath, path.dirname(name)),
      path.dirname(pkg)
    );
    const nodeModulesCount = (
      pkg.match(/node_modules/g) || []
    ).length;
    const isStoreResolved =
      pkg.includes(`${path.sep}.bun${path.sep}`) ||
      pkg.includes(`${path.sep}.pnpm${path.sep}`);
    const maxDepth = isStoreResolved ? 2 : 1;

    if (nodeModulesCount <= maxDepth && !created.has(name)) {
      created.add(name);
      await link(target, path.join(toPath, name), this.settings.linkType);
    }

    // Get dependencies
    const { dependencies = {} } = require(pkg);

    // Link all dependencies
    await Promise.all(
      Object.keys(dependencies).map((dep) =>
        this.linkPackage(
          dep,
          path.dirname(pkg),
          toPath,
          created,
          resolved.concat([name])
        )
      )
    );
  }

  async clean() {
    this.log('Cleaning dependency symlinks');

    const nodeModulesDir = path.join(this.settings.path, 'node_modules');

    if (usesSymlinkStore(this.packageManager)) {
      await this.cleanSelective(nodeModulesDir);
    } else {
      // Check if a manifest exists from a previous bun/pnpm run
      const manifest = await readManifest(nodeModulesDir);
      if (manifest.length > 0) {
        await this.cleanSelective(nodeModulesDir);
      } else {
        await this.cleanAll(nodeModulesDir);
      }
    }
  }

  /** Selective clean: only remove symlinks listed in the manifest. */
  private async cleanSelective(nodeModulesDir: string) {
    const manifest = await readManifest(nodeModulesDir);
    if (manifest.length === 0) {
      this.log('No manifest found, skipping selective clean');
      await removeManifest(nodeModulesDir);
      return;
    }

    for (const name of manifest) {
      const linkPath = path.join(nodeModulesDir, name);
      try {
        const stat = await fs.lstat(linkPath);
        if (stat.isSymbolicLink()) {
          await fs.unlink(linkPath);
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
      }

      // Clean up empty scoped package directories
      if (name.startsWith('@')) {
        const scopeDir = path.join(nodeModulesDir, name.split('/')[0]);
        try {
          const files = await fs.readdir(scopeDir);
          if (files.length === 0) {
            await fs.rmdir(scopeDir);
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }
      }
    }

    await removeManifest(nodeModulesDir);
  }

  /** Legacy clean: remove ALL symlinks from node_modules (npm/yarn behavior). */
  private async cleanAll(p: string) {
    type File = { f: string; s: fs.Stats };

    const isScopedPkgDir = (c: File) =>
      c.s.isDirectory() && c.f.startsWith('@');

    async function clean(p: string) {
      if (!(await fs.pathExists(p))) {
        return;
      }

      const files = await fs.readdir(p);
      let contents: File[] = await Promise.all(
        files.map((f) => fs.lstat(path.join(p, f)).then((s) => ({ f, s })))
      );

      // Remove all links
      await Promise.all(
        contents
          .filter((c) => c.s.isSymbolicLink())
          .map((c) => fs.unlink(path.join(p, c.f)))
      );
      contents = contents.filter((c) => !c.s.isSymbolicLink());

      // Remove all links in scoped packages
      await Promise.all(
        contents.filter(isScopedPkgDir).map((c) => clean(path.join(p, c.f)))
      );
      contents = contents.filter((c) => !isScopedPkgDir(c));

      // Remove directory if empty
      const filesInDir = await fs.readdir(p);
      if (!filesInDir.length) {
        await fs.rmdir(p);
      }
    }

    await clean(p);
  }

  async initialise() {
    // Read package JSON
    const { dependencies = {} } = require(path.join(
      this.settings.path,
      'package.json'
    ));

    // Link all dependent packages
    this.log('Creating dependency symlinks');
    const created = new Set<string>();
    await Promise.all(
      Object.keys(dependencies).map((name) =>
        this.linkPackage(
          name,
          this.settings.path,
          path.join(this.settings.path, 'node_modules'),
          created,
          []
        )
      )
    );

    // Write manifest for bun/pnpm so clean() knows what to remove
    const nodeModulesDir = path.join(this.settings.path, 'node_modules');
    if (usesSymlinkStore(this.packageManager)) {
      await writeManifest(nodeModulesDir, Array.from(created));
    }
  }
}

// CJS export for compiled output (tsc emits CommonJS)
if (typeof module !== 'undefined') {
  module.exports = ServerlessMonoRepo;
}
export default ServerlessMonoRepo;
