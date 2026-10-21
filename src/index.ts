export * from "./process.ts"
export * from "./gitlink.ts"
export * from "./gitlink-carrier.ts"
export * from "./pull.ts"
export * from "./push.ts"
export * from "./result.ts"
export { superBranchRetire, type SuperBranchRetireOptions, type SuperBranchRetireResult } from "./branch-retire.ts"
export { readReflogEntries, type ReflogEntry } from "./retention-contents.ts"
export { verifyRetainedCopy, type RetainedCopyProof } from "./retention-compact.ts"
export {
  verifyRetainedEntry,
  retentionRemovalBoundary,
  type RetentionGateId,
  type RetentionGateResult,
  type RetentionGateStatus,
  type RetentionVerifyOptions,
  type RetentionVerifyResult,
  type RetentionVerifyVerdict,
} from "./retention-verify.ts"
export {
  inspectCheckoutGitMetadata,
  projectPrivateGitWorktree,
  retainPrivateGitProjection,
  retirePrivateGitProjection,
  type PrivateGitProjection,
  type PrivateGitStopCertificate,
  type PrivateGitProjectionOptions,
  type PrivateGitProjectionResult,
} from "./private-git-projection.ts"
export {
  superSubmodulePrepare,
  prepareSubmoduleTreeUnderLock,
  type PreparedSubmodule,
  type SuperSubmodulePrepareResult,
  type SuperSubmodulePrepareOptions,
} from "./submodule-prepare.ts"
export {
  registrationNameForOwner,
  ownerFromRegistrationName,
  worktreeHomeRoot,
  DEFAULT_WORKTREE_HOME,
  WORKTREE_HOME_ENV,
  POOL_ROOT_CONFIG_KEY,
  type WorktreeHomeOptions,
} from "./worktree-add.ts"
export {
  archiveModuleStores,
  describeModuleStores,
  inspectDestroyedModuleStores,
  inspectModuleStores,
  moduleStoreValue,
  type ModuleArchiveTarget,
  type ModuleInventory,
  type ModuleStore,
} from "./module-store-custody.ts"
