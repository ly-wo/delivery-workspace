import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LocalProject, ProjectsData } from '../shared/hub.js';
const exec = promisify(execFile);
/** Extend the existing project inventory with registered linked trees and host-created session trees. */
export function createWorkspaceDiscovery(readProjects: (refresh?: boolean) => Promise<ProjectsData>, managedRoot: string, readSessionPaths: () => string[] | Promise<string[]> = () => []) {
  let pending: Promise<ProjectsData> | undefined, cached: ProjectsData | undefined, expires = 0;
  return async (refresh = false): Promise<ProjectsData> => {
    if (!refresh && cached && Date.now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const source = await readProjects(refresh), found = new Map(source.projects.map(p => [path.resolve(p.path), p]));
      const children = await fs.readdir(managedRoot, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
      for (const child of children) if (child.isDirectory() && /^[a-f0-9-]{36}$/.test(child.name)) {
        const folder = path.join(managedRoot, child.name);
        if (!found.has(folder)) found.set(folder, { path: folder, displayName: '会话工作区', branch: '' } as LocalProject);
      }
      // Imported/local sessions can point outside configured project roots. Use their
      // working directories to discover registered trees, never as deletion targets directly.
      const seedMap = new Map(found);
      for (const folder of await readSessionPaths()) if (path.isAbsolute(folder) && !seedMap.has(path.resolve(folder))) {
        seedMap.set(path.resolve(folder), { path: path.resolve(folder), displayName: path.basename(folder), branch: '' } as LocalProject);
      }
      const seeds = [...seedMap.values()]; let cursor = 0, failures = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < seeds.length) {
          const project = seeds[cursor++];
          try {
            const { stdout } = await exec('git', ['-C', project.path, 'worktree', 'list', '--porcelain', '-z'], { timeout: 10000, maxBuffer: 2_000_000 });
            let folder = '';
            for (const field of stdout.split('\0')) {
              if (field.startsWith('worktree ')) { folder = field.slice(9); if (!found.has(folder)) found.set(folder, { ...project, path: folder, branch: '', createdAt: undefined, lastActivityAt: undefined }); }
              else if (field.startsWith('branch ') && folder) found.get(folder)!.branch = field.slice(7).replace(/^refs\/heads\//, '');
              else if (!field) folder = '';
            }
          } catch { failures++; }
        }
      }));
      cached = { ...source, projects: [...found.values()], unreadableCount: (source.unreadableCount || 0) + failures };
      expires = Date.now() + 60_000; return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
