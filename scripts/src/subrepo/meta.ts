import { join as joinPaths } from 'path'
import { readFile, writeFile, copyFile, rm } from 'fs/promises'
import { ScriptContext } from '@fullcalendar/standard-scripts/utils/script-runner'
import {
  addFile,
  assumeUnchanged,
  checkoutFile,
  commitDir,
  isStaged,
} from '@fullcalendar/standard-scripts/utils/git'
import { fileExists } from '@fullcalendar/standard-scripts/utils/fs'
import { boolPromise } from '@fullcalendar/standard-scripts/utils/lang'
import { querySubrepoSubdirs } from '../utils/git-subrepo.js'

// config
import ghostFileConfigMap, { GhostFileConfig } from '../../config/subrepo-meta.js'

export default async function(this: ScriptContext, ...args: string[]) {
  const { monorepoDir } = this.monorepoStruct

  await updateGhostFiles(
    monorepoDir,
    await querySubrepoSubdirs(monorepoDir),
    !args.includes('--no-commit'),
  )
}

export async function hideMonorepoGhostFiles(monorepoDir: string) {
  const subdirs = await querySubrepoSubdirs(monorepoDir)
  const ghostFilePaths = getGhostFilePaths(monorepoDir, subdirs)

  await hideFiles(ghostFilePaths)
}

export async function updateGhostFiles(
  monorepoDir: string,
  subdirs: string[] = [],
  doCommit = true,
) {
  const ghostFilePaths = getGhostFilePaths(monorepoDir, subdirs)

  await revealFiles(ghostFilePaths)
  await writeFiles(monorepoDir, subdirs)
  const anyAdded = await addFiles(ghostFilePaths)

  if (anyAdded && doCommit) {
    await commitDir(monorepoDir, 'subrepo meta file changes')
  }

  // if not committed, files will be seen as staged, even after hiding them
  await hideFiles(ghostFilePaths)
}

function getGhostFilePaths(monorepoDir: string, subdirs: string[]): string[] {
  const ghostFileSubpaths = Object.keys(ghostFileConfigMap)
  const paths: string[] = []

  for (const subdir of subdirs) {
    for (const ghostFilePath of ghostFileSubpaths) {
      paths.push(joinPaths(monorepoDir, subdir, ghostFilePath))
    }
  }

  return paths
}

// Generation
// -------------------------------------------------------------------------------------------------

async function writeFiles(monorepoDir: string, subdirs: string[]) {
  await Promise.all(
    subdirs.map((subdir) => writeSubdirFiles(monorepoDir, subdir)),
  )
}

async function writeSubdirFiles(monorepoDir: string, subdir: string): Promise<void> {
  await Promise.all(
    Object.keys(ghostFileConfigMap).map(async (ghostFileSubpath) => {
      const ghostFileConfig = ghostFileConfigMap[ghostFileSubpath]
      await writeSubdirFile(monorepoDir, subdir, ghostFileSubpath, ghostFileConfig)
    }),
  )
}

async function writeSubdirFile(
  monorepoDir: string,
  subdir: string,
  ghostFileSubpath: string,
  ghostFileConfig: GhostFileConfig,
): Promise<void> {
  if (ghostFileConfig.generator) {
    const readOrig = () => readFile(joinPaths(monorepoDir, ghostFileSubpath), 'utf8')
    const res = await ghostFileConfig.generator(readOrig, monorepoDir, subdir)

    if (typeof res === 'string') {
      await writeFile(joinPaths(monorepoDir, subdir, ghostFileSubpath), res)
    }
  } else {
    await copyFile(
      joinPaths(monorepoDir, ghostFileSubpath),
      joinPaths(monorepoDir, subdir, ghostFileSubpath),
    )
  }
}

// Git utils
// -------------------------------------------------------------------------------------------------

async function revealFiles(paths: string[]): Promise<void> {
  for (let path of paths) {
    const inIndex = await boolPromise(assumeUnchanged(path, false))
    if (inIndex) {
      await checkoutFile(path)
    }
  }
}

async function addFiles(paths: string[]): Promise<boolean> {
  let anyAdded = false

  for (let path of paths) {
    // TODO: refactor this file to only add generated paths that return string/true
    if (await fileExists(path)) {
      await addFile(path)

      if (await isStaged(path)) {
        anyAdded = true
      }
    }
  }

  return anyAdded
}

async function hideFiles(paths: string[]): Promise<void> {
  for (let path of paths) {
    const inIndex = await boolPromise(assumeUnchanged(path, true))
    if (inIndex) {
      await rm(path, { force: true })
    }
  }
}
