import * as fs from 'fs-extra';
import * as path from 'path';

const MANIFEST_NAME = '.serverless-monorepo-links.json';

function manifestPath(nodeModulesDir: string): string {
  return path.join(nodeModulesDir, MANIFEST_NAME);
}

/** Read the list of plugin-created symlink names. Returns empty array if no manifest. */
export async function readManifest(nodeModulesDir: string): Promise<string[]> {
  const p = manifestPath(nodeModulesDir);
  if (!(await fs.pathExists(p))) {
    return [];
  }
  try {
    const data = await fs.readJson(p);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Write the list of plugin-created symlink names to the manifest. */
export async function writeManifest(
  nodeModulesDir: string,
  names: string[]
): Promise<void> {
  await fs.ensureDir(nodeModulesDir);
  await fs.writeJson(manifestPath(nodeModulesDir), names);
}

/** Remove the manifest file if it exists. */
export async function removeManifest(nodeModulesDir: string): Promise<void> {
  const p = manifestPath(nodeModulesDir);
  if (await fs.pathExists(p)) {
    await fs.unlink(p);
  }
}
