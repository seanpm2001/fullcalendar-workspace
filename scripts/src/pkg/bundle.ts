import { join as joinPaths, resolve as resolvePath, dirname, isAbsolute } from 'path'
import { watch as watchPaths } from 'chokidar'
import { globby } from 'globby'
import {
  rollup,
  watch as rollupWatch,
  RollupWatcher,
  OutputOptions as RollupOutputOptions,
  Plugin as RollupPlugin,
} from 'rollup'
import nodeResolvePlugin from '@rollup/plugin-node-resolve'
import { default as commonjsPlugin } from '@rollup/plugin-commonjs'
import { default as jsonPlugin } from '@rollup/plugin-json'
import { default as postcssPlugin } from 'rollup-plugin-postcss'
import { default as sourcemapsPlugin } from 'rollup-plugin-sourcemaps'
import { default as dtsPlugin } from 'rollup-plugin-dts'
import { workspaceScriptsDir } from '../root/lib.js'
import { EntryConfig, EntryConfigMap, readSrcPkgMeta, SrcPkgMeta } from './meta.js'
import { live } from '../utils/exec.js'

// TODO: continuous rollup building can do multiple output options

export default async function(...args: string[]) {
  const pkgDir = process.cwd()
  const isDev = args.indexOf('--dev') !== -1
  const isWatch = args.indexOf('--watch') !== -1

  if (isWatch) {
    let rollupWatchers: RollupWatcher[] = []

    const closeRollupWatchers = () => {
      for (let bundler of rollupWatchers) {
        bundler.close()
      }
    }

    const srcJsonPath = joinPaths(pkgDir, 'package.json')
    const srcJsonWatcher = watchPaths(srcJsonPath).on('all', async () => {
      const pkgAnalysis = await analyzePkg(pkgDir)

      closeRollupWatchers()
      rollupWatchers = [
        continuouslyBundleModules(pkgAnalysis, isDev),
        ...continuouslyBundleIifes(pkgAnalysis),
      ]
    })

    return new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        srcJsonWatcher.close()
        closeRollupWatchers()
        resolve()
      })
    })
  } else {
    const pkgAnalysis = await analyzePkg(pkgDir)

    return Promise.all([
      bundleModules(pkgAnalysis, isDev),
      bundleIifes(pkgAnalysis),
      bundleTypes(pkgAnalysis),
    ])
  }
}

// Bundling Modules
// -------------------------------------------------------------------------------------------------

async function bundleModules(pkgAnalysis: PkgAnalysis, isDev: boolean): Promise<void> {
  const buildConfig = pkgAnalysis.pkgMeta.buildConfig || {}
  const esmEnabled = buildConfig.esm ?? true
  const cjsEnabled = buildConfig.cjs ?? true

  if (!esmEnabled && !cjsEnabled) {
    return Promise.resolve()
  }

  return rollup({
    input: buildInputMap(pkgAnalysis, '.js'),
    plugins: buildModulePlugins(pkgAnalysis, isDev),
  }).then((bundle) => {
    return Promise.all([
      (esmEnabled) && bundle.write(buildEsmOutputOptions(pkgAnalysis.pkgDir, isDev)),
      (!isDev && cjsEnabled) && bundle.write(buildCjsOutputOptions(pkgAnalysis.pkgDir)),
    ]).then(() => {
      bundle.close()
    })
  })
}

function continuouslyBundleModules(pkgAnalysis: PkgAnalysis, isDev: boolean): RollupWatcher {
  return rollupWatch({
    input: buildInputMap(pkgAnalysis, '.js'),
    plugins: buildModulePlugins(pkgAnalysis, isDev),
    output: buildEsmOutputOptions(pkgAnalysis.pkgDir, isDev),
  })
}

function buildModulePlugins(pkgAnalysis: PkgAnalysis, isDev: boolean): (RollupPlugin | false)[]  {
  return [
    generatedContentPlugin(pkgAnalysis),
    externalizeDepsPlugin(pkgAnalysis),
    rerootAssetsPlugin(pkgAnalysis.pkgDir),
    isDev && sourcemapsPlugin(), // load preexisting sourcemaps
    ...buildContentProcessingPlugins(),
  ]
}

function buildEsmOutputOptions(pkgDir: string, isDev: boolean): RollupOutputOptions {
  return {
    format: 'esm',
    dir: joinPaths(pkgDir, 'dist'),
    entryFileNames: '[name].mjs',
    sourcemap: isDev,
  }
}

function buildCjsOutputOptions(pkgDir: string): RollupOutputOptions {
  return {
    format: 'cjs',
    exports: 'named',
    dir: joinPaths(pkgDir, 'dist'),
    entryFileNames: '[name].cjs',
  }
}

// Bundling IIFEs
// -------------------------------------------------------------------------------------------------

function bundleIifes(pkgAnalysis: PkgAnalysis): Promise<void> {
  const { pkgDir, entryConfigMap, relSrcPathMap } = pkgAnalysis
  const promises: Promise<void>[] = []

  for (const entryId in relSrcPathMap) {
    const relSrcPaths = relSrcPathMap[entryId]
    const entryConfig = entryConfigMap[entryId]
    const iifeConfig = entryConfig.iife

    if (iifeConfig) {
      for (const relSrcPath of relSrcPaths) {
        const outputOptions = buildIifeOutputOptions(pkgDir, entryConfig, relSrcPath)

        promises.push(
          rollup({
            input: buildTscPath(pkgDir, relSrcPath, '.iife.js'),
            plugins: buildIifePlugins(pkgAnalysis, iifeConfig.globals || {}),
          }).then((bundle) => {
            return bundle.write(outputOptions)
              .then(() => Promise.all([
                bundle.close(),
                minifyFile(outputOptions.file!),
              ]).then())
          })
        )
      }
    }
  }

  return Promise.all(promises).then()
}

function continuouslyBundleIifes(pkgAnalysis: PkgAnalysis): RollupWatcher[] {
  const { pkgDir, entryConfigMap, relSrcPathMap } = pkgAnalysis
  const watchers: RollupWatcher[] = []

  for (const entryId in relSrcPathMap) {
    const relSrcPaths = relSrcPathMap[entryId]
    const entryConfig = entryConfigMap[entryId]
    const iifeConfig = entryConfig.iife

    if (iifeConfig) {
      for (const relSrcPath of relSrcPaths) {
        const outputOptions = buildIifeOutputOptions(pkgDir, entryConfig, relSrcPath)

        watchers.push(
          rollupWatch({
            input: buildTscPath(pkgDir, relSrcPath, '.iife.js'),
            plugins: buildIifePlugins(pkgAnalysis, iifeConfig.globals || {}),
            output: outputOptions,
          })
        )
      }
    }
  }

  return watchers
}

function buildIifePlugins(pkgAnalysis: PkgAnalysis, iifeGlobals: any): RollupPlugin[] {
  return [
    generatedContentPlugin(pkgAnalysis),
    externalizeGlobals(iifeGlobals),
    rerootAssetsPlugin(pkgAnalysis.pkgDir),
    ...buildContentProcessingPlugins(),
  ]
}

function buildIifeOutputOptions(
  pkgDir: string,
  entryConfig: EntryConfig,
  relSrcPath: string,
): RollupOutputOptions {
  const iifeConfig = entryConfig.iife || {}

  return {
    format: 'iife',
    file: joinPaths(pkgDir, 'dist', buildOutputId(relSrcPath)) + '.js',
    globals: iifeConfig.globals || {},
    ...(
      typeof iifeConfig.name === 'string'
        ? { name: iifeConfig.name }
        : { exports: 'none' }
    )
  }
}

async function minifyFile(unminifiedIifePath: string): Promise<void> {
  return live([
    'pnpm', 'exec', 'terser',
    '--config-file', 'terser.json',
    '--output', unminifiedIifePath.replace(/\.js$/, '.min.js'),
    '--', unminifiedIifePath,
  ], {
    cwd: workspaceScriptsDir,
  })
}

// Types
// -------------------------------------------------------------------------------------------------

async function bundleTypes(pkgAnalysis: PkgAnalysis): Promise<void> {
  const typesEnabled = pkgAnalysis.pkgMeta.buildConfig?.types ?? true

  if (!typesEnabled) {
    return Promise.resolve()
  }

  return rollup({
    input: buildInputMap(pkgAnalysis, '.d.ts'),
    plugins: buildTypesPlugins(pkgAnalysis),
  }).then((bundle) => {
    return bundle.write(buildTypesOutputOptions(pkgAnalysis.pkgDir)).then(() => {
      bundle.close()
    })
  })
}

function buildTypesPlugins(pkgAnalysis: PkgAnalysis): RollupPlugin[] {
  return [
    externalizeAssetsPlugin(),
    externalizeDepsPlugin(pkgAnalysis),
    externalizeExportsPlugin(pkgAnalysis), // because dts-bundler gets confused by code-splitting
    dtsPlugin(),
    nodeResolvePlugin(),
  ]
}

function buildTypesOutputOptions(pkgDir: string): RollupOutputOptions {
  return {
    format: 'esm',
    dir: joinPaths(pkgDir, 'dist'),
    entryFileNames: '[name].d.ts',
  }
}

// Rollup Input
// -------------------------------------------------------------------------------------------------

type RollupInputMap = { [outputId: string]: string }

function buildInputMap(pkgAnalysis: PkgAnalysis, ext: string): RollupInputMap {
  const { pkgDir, relSrcPathMap } = pkgAnalysis
  const inputs: { [outputId: string]: string } = {}

  for (let entryId in relSrcPathMap) {
    const relSrcPaths = relSrcPathMap[entryId]

    for (const relSrcPath of relSrcPaths) {
      const outputId = buildOutputId(relSrcPath)
      inputs[outputId] = buildTscPath(pkgDir, relSrcPath, ext)
    }
  }

  return inputs
}

// Rollup Plugins
// -------------------------------------------------------------------------------------------------

function buildContentProcessingPlugins() {
  return [
    nodeResolvePlugin({ // determines index.js and .js/cjs/mjs
      browser: true, // for xhr-mock (use non-node shims that it wants to)
      preferBuiltins: false // for xhr-mock (use 'url' npm package)
    }),
    commonjsPlugin(), // for moment and moment-timezone
    jsonPlugin(), // for moment-timezone
    postcssPlugin({
      config: {
        path: joinPaths(workspaceScriptsDir, 'postcss.config.cjs'),
        ctx: {}, // arguments given to config file
      }
    })
  ]
}

function externalizeDepsPlugin(pkgAnalysis: PkgAnalysis): RollupPlugin {
  const { pkgMeta } = pkgAnalysis
  const deps = {
    ...pkgMeta.dependencies,
    ...pkgMeta.peerDependencies,
    // will NOT externalize devDependencies
  }

  return {
    name: 'externalize-deps',
    resolveId(id) {
      const pkgName = extractPkgName(id)

      if (pkgName && (pkgName in deps)) {
        return { id, external: true }
      }
    },
  }
}

function externalizeGlobals(iifeGlobals: any): RollupPlugin {
  return {
    name: 'externalize-globals',
    resolveId(id) {
      if (iifeGlobals[id]) {
        return { id, external: true }
      }
    }
  }
}

function externalizeExportsPlugin(pkgAnalysis: PkgAnalysis): RollupPlugin {
  const { pkgDir, relSrcPathMap } = pkgAnalysis
  const tscPathMap: { [tscPath: string]: boolean } = {}

  for (let entryId in relSrcPathMap) {
    const relSrcPaths = relSrcPathMap[entryId]

    for (const relSrcPath of relSrcPaths) {
      tscPathMap[buildTscPath(pkgDir, relSrcPath, '.js')] = true
    }
  }

  return {
    name: 'externalize-exports',
    resolveId(id, importer) {
      const importPath = computeImportPath(id, importer)

      if (importPath && tscPathMap[importPath]) {
        return {
          // out source files reference eachother via .js, but esm output uses .mjs
          id: id.replace(/\.js$/, '.mjs'),
          external: true,
        }
      }
    }
  }
}

function externalizeAssetsPlugin(): RollupPlugin {
  return {
    name: 'externalize-assets',
    resolveId(id, importer) {
      const importPath = computeImportPath(id, importer)

      if (importPath && isPathAsset(importPath)) {
        return { id, external: true }
      }
    }
  }
}

function rerootAssetsPlugin(pkgDir: string): RollupPlugin {
  const srcDir = joinPaths(pkgDir, 'src')
  const tscDir = joinPaths(pkgDir, 'dist', '.tsc')

  return {
    name: 'reroot-assets',
    resolveId(id, importer) {
      const importPath = computeImportPath(id, importer)

      if (importPath && isPathAsset(importPath)) {
        if (isPathWithinDir(importPath, tscDir)) {
          return srcDir + importPath.substring(tscDir.length)
        }
      }
    }
  }
}

function generatedContentPlugin(pkgAnalysis: PkgAnalysis): RollupPlugin {
  const { pkgDir, entryContentMap, iifeEntryContentMap } = pkgAnalysis
  const pathContentMap: { [path: string]: string } = {}

  for (let entryId in entryContentMap) {
    pathContentMap[buildTscPath(pkgDir, entryId, '.js')] = entryContentMap[entryId]
  }

  for (let entryId in iifeEntryContentMap) {
    pathContentMap[buildTscPath(pkgDir, entryId, '.iife.js')] = iifeEntryContentMap[entryId]
  }

  return {
    name: 'generated-content',
    async resolveId(id, importer) {
      const importPath = computeImportPath(id, importer)

      if (importPath && pathContentMap[importPath]) {
        return importPath
      }
    },
    load(id) {
      return pathContentMap[id] // if undefined, fallback to normal file load
    }
  }
}

// Package Analysis
// -------------------------------------------------------------------------------------------------

interface PkgAnalysis {
  pkgDir: string
  pkgMeta: SrcPkgMeta
  entryConfigMap: EntryConfigMap
  relSrcPathMap: RelSrcPathMap
  entryContentMap: EntryContentMap // entryIds are expanded
  iifeEntryContentMap: EntryContentMap // entryIds are expanded
}

async function analyzePkg(pkgDir: string): Promise<PkgAnalysis> {
  const pkgMeta = await readSrcPkgMeta(pkgDir)
  const buildConfig = pkgMeta.buildConfig || {}
  const entryConfigMap = buildConfig.exports || {}
  const relSrcPathMap: RelSrcPathMap = {}
  const entryContentMap: EntryContentMap = {}
  const iifeEntryContentMap: EntryContentMap = {}

  await Promise.all(
    Object.keys(entryConfigMap).map(async (entryId) => {
      const entryConfig = entryConfigMap[entryId]
      let relSrcPaths: string[]

      if (entryConfig.generator) {
        const generatorPath = joinPaths(pkgDir, entryConfig.generator)
        const contentMap = await generateEntryContent(entryId, generatorPath)

        Object.assign(entryContentMap, contentMap)

        relSrcPaths = Object.keys(contentMap).map((entryId) => entryId + '.ts')
      } else {
        relSrcPaths = await queryRelSrcPaths(pkgDir, entryId)
      }

      relSrcPathMap[entryId] = relSrcPaths

      const iifeGenerator = entryConfig.iife?.generator
      if (iifeGenerator) {
        for (const relSrcPath of relSrcPaths) {
          const expandedEntryId = relSrcPath.replace(/\.tsx?/, '') // TODO: util
          const generatorPath = joinPaths(pkgDir, iifeGenerator)
          const contentMap = await generateEntryContent(expandedEntryId, generatorPath)
          for (let entryId in contentMap) {
            iifeEntryContentMap[entryId] = contentMap[entryId]
          }
        }
      }
    })
  )

  return {
    pkgDir,
    pkgMeta,
    entryConfigMap,
    relSrcPathMap,
    entryContentMap,
    iifeEntryContentMap,
  }
}

// Generated Content
// -------------------------------------------------------------------------------------------------

type EntryContentMap = { [expandedEntryId: string]: string }

async function generateEntryContent(
  entryId: string,
  generatorPath: string,
): Promise<EntryContentMap> {
  const generatorExports = await import(generatorPath)
  const generatorFunc = generatorExports.default
  const entryContentMap: EntryContentMap = {}

  if (typeof generatorFunc !== 'function') {
    throw new Error('Generator must have a default function export')
  }

  const generatorRes = await generatorFunc(entryId)

  if (typeof generatorRes === 'string') {
    if (entryId.indexOf('*') !== -1) {
      throw new Error('Generator string output can\'t have blob entrypoint name')
    }

    entryContentMap[entryId] = generatorRes

  } else if (typeof generatorRes === 'object') {
    if (entryId.indexOf('*') === -1) {
      throw new Error('Generator object output must have blob entrypoint name')
    }

    for (const key in generatorRes) {
      const expandedEntryId = entryId.replace('*', key)
      entryContentMap[expandedEntryId] = generatorRes[key]
    }
  } else {
    throw new Error('Invalid type of generator output')
  }

  return entryContentMap
}

// App-Specific Path Utils
// -------------------------------------------------------------------------------------------------

type RelSrcPathMap = { [entryId: string]: string[] }

async function queryRelSrcPaths(pkgDir: string, entryId: string): Promise<string[]> {
  const srcDir = joinPaths(pkgDir, 'src')

  return (
    await globby(
      (entryId === '.' ? 'index' : entryId.replace(/^\.\//, '')) + '.{ts,tsx}',
      { cwd: srcDir },
    )
  ).map((entry) => entry.toString())
}

function buildTscPath(pkgDir: string, relSrcPath: string, ext: string) {
  return joinPaths(pkgDir, 'dist', '.tsc', relSrcPath).replace(/\.tsx?$/, '') + ext
}

function computeImportPath(id: string, importer: string | undefined): string | undefined {
  // an entrypoint
  if (!importer) {
    if (isPathRelative(id)) {
      return resolvePath(id) // relative to CWD
    } else {
      return id
    }
  } else {
    if (isPathRelative(id)) {
      return joinPaths(dirname(importer), id)
    }
    // otherwise, probably a dependency
  }
}

function buildOutputId(relSrcPath: string): string {
  return relSrcPath
    .replace(/^\.\//, '') // TODO: use util
    .replace(/\.[jt]sx?$/, '')
}

function isPathAsset(path: string): boolean {
  const assetExts = ['.css']

  for (let assetExt of assetExts) {
    if (path.endsWith(assetExt)) {
      return true
    }
  }

  return false
}

// General Path Utils
// -------------------------------------------------------------------------------------------------

function isPathWithinDir(path: string, dirPath: string): boolean {
  return path.indexOf(
    joinPaths(dirPath, 'a').replace(/a$/, '')
  ) === 0
}

function isPathRelative(path: string): boolean {
  return /^\.\.?\/?/.test(path)
}

function extractPkgName(importId: string): string | undefined {
  const m = importId.match(/^(@[a-z-.]+\/)?[a-z-.]+/)

  if (m) {
    return m[0]
  }
}
