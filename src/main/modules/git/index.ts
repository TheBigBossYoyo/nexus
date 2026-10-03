export { GitService, parseStatusV2, parseDiffFiles, parseWorktreeList } from './git-service'
export type {
  GitAuthor,
  GitStatus,
  StatusEntry,
  DiffFile,
  DiffStatus,
  DiffResult,
  WorktreeInfo,
  CommitInfo,
  MergeResult,
  RunGitOptions,
} from './git-service'
export { WorktreeManager } from './worktree-manager'
export type { PlannedPaths, CreatedWorktree, OrphanReport, CleanupReport } from './worktree-manager'
export { isPathInside, pathKey } from './paths'
