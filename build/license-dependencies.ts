import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Dependency as RollupLicenseDependency } from 'rollup-plugin-license'

import type { NaidanLicense } from '../src/models/naidan-license'

export type BuildLicenseDependency = NaidanLicense

const dependencyMapSchema = z.record(z.string(), z.string())
const legacyLicenseSchema = z.union([
  z.string(),
  z.object({ type: z.string() }).passthrough(),
])
const packageJsonSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  license: legacyLicenseSchema.optional(),
  licenses: z.array(legacyLicenseSchema).optional(),
  dependencies: dependencyMapSchema.optional(),
  optionalDependencies: dependencyMapSchema.optional(),
}).passthrough()

type PackageJson = z.infer<typeof packageJsonSchema>
type DependencyQueueItem = Readonly<{
  dependencyName: string
  fromDirectory: string
  requirement: 'required' | 'optional'
}>

export function convertRollupLicenseDependency({ dependency }: {
  dependency: RollupLicenseDependency
}): BuildLicenseDependency | undefined {
  if (dependency.name === null || dependency.version === null) return undefined
  return {
    name: dependency.name,
    version: dependency.version,
    license: dependency.license,
    licenseText: dependency.licenseText,
  }
}

function compareStrings({ left, right }: { left: string, right: string }): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function mergeBuildLicenseDependencies({ dependencyGroups }: {
  dependencyGroups: readonly (readonly BuildLicenseDependency[])[]
}): readonly BuildLicenseDependency[] {
  const merged = new Map<string, BuildLicenseDependency>()
  for (const dependencies of dependencyGroups) {
    for (const dependency of dependencies) {
      merged.set(`${dependency.name}\0${dependency.version}`, dependency)
    }
  }
  return [...merged.values()].sort((left, right) => {
    const nameOrder = compareStrings({ left: left.name, right: right.name })
    return nameOrder === 0
      ? compareStrings({ left: left.version, right: right.version })
      : nameOrder
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function readPackageJson({ packageJsonPath }: { packageJsonPath: string }): Promise<PackageJson> {
  const source = await fs.readFile(packageJsonPath, 'utf8')
  return packageJsonSchema.parse(JSON.parse(source))
}

function createDependencyQueueItems({ packageJson, packageDirectory }: {
  packageJson: PackageJson
  packageDirectory: string
}): readonly DependencyQueueItem[] {
  const optionalDependencyNames = new Set(Object.keys(packageJson.optionalDependencies ?? {}))
  const dependencyNames = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...optionalDependencyNames,
  ])
  return [...dependencyNames].map((dependencyName) => ({
    dependencyName,
    fromDirectory: packageDirectory,
    requirement: optionalDependencyNames.has(dependencyName) ? 'optional' : 'required',
  }))
}

async function findInstalledPackageJson({ dependencyName, fromDirectory }: {
  dependencyName: string
  fromDirectory: string
}): Promise<string | undefined> {
  const dependencyPathSegments = dependencyName.split('/')
  let currentDirectory = path.resolve(fromDirectory)
  for (;;) {
    const packageJsonPath = path.join(currentDirectory, 'node_modules', ...dependencyPathSegments, 'package.json')
    try {
      await fs.access(packageJsonPath)
      return packageJsonPath
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) return undefined
    currentDirectory = parentDirectory
  }
}

function normalizeLicense({ packageJson }: { packageJson: PackageJson }): string | null {
  const stringifyLicense = (license: z.infer<typeof legacyLicenseSchema>): string => (
    typeof license === 'string' ? license : license.type
  )
  if (packageJson.license !== undefined) return stringifyLicense(packageJson.license)
  if (packageJson.licenses === undefined || packageJson.licenses.length === 0) return null
  return `(${packageJson.licenses.map(stringifyLicense).join(' OR ')})`
}

async function readLicenseText({ packageDirectory }: { packageDirectory: string }): Promise<string | null> {
  const entries = await fs.readdir(packageDirectory, { withFileTypes: true })
  const licenseFileName = entries
    .filter((entry) => entry.isFile() && /^(?:license|licence)(?:$|[._-])/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareStringsForSort)[0]
  return licenseFileName === undefined
    ? null
    : fs.readFile(path.join(packageDirectory, licenseFileName), 'utf8')
}

function compareStringsForSort(left: string, right: string): number {
  return compareStrings({ left, right })
}

export async function collectDevelopmentLicenseDependencies({ root }: {
  root: string
}): Promise<readonly BuildLicenseDependency[]> {
  const rootPackageJsonPath = path.join(root, 'package.json')
  const rootPackageJson = await readPackageJson({ packageJsonPath: rootPackageJsonPath })
  const queue = [...createDependencyQueueItems({ packageJson: rootPackageJson, packageDirectory: root })]
  const visitedPackageJsonPaths = new Set<string>()
  const dependencies: BuildLicenseDependency[] = []

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) break
    const packageJsonPath = await findInstalledPackageJson({
      dependencyName: item.dependencyName,
      fromDirectory: item.fromDirectory,
    })
    if (packageJsonPath === undefined) {
      switch (item.requirement) {
      case 'required':
        throw new Error(`Required development license dependency is not installed: ${item.dependencyName}`)
      case 'optional':
        continue
      default: {
        const _exhaustive: never = item.requirement
        throw new Error(`Unsupported development dependency requirement: ${_exhaustive}`)
      }
      }
    }
    const canonicalPackageJsonPath = await fs.realpath(packageJsonPath)
    if (visitedPackageJsonPaths.has(canonicalPackageJsonPath)) continue
    visitedPackageJsonPaths.add(canonicalPackageJsonPath)

    const packageJson = await readPackageJson({ packageJsonPath: canonicalPackageJsonPath })
    const packageDirectory = path.dirname(canonicalPackageJsonPath)
    if (packageJson.name === undefined || packageJson.version === undefined) {
      throw new Error(`Installed dependency has an incomplete package identity: ${canonicalPackageJsonPath}`)
    }
    if (packageJson.private !== true) {
      dependencies.push({
        name: packageJson.name,
        version: packageJson.version,
        license: normalizeLicense({ packageJson }),
        licenseText: await readLicenseText({ packageDirectory }),
      })
    }
    queue.push(...createDependencyQueueItems({ packageJson, packageDirectory }))
  }

  return mergeBuildLicenseDependencies({ dependencyGroups: [dependencies] })
}
