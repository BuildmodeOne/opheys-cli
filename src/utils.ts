import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { log, spinner } from '@clack/prompts'
import crossSpawn from 'cross-spawn'

class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

function runCmd(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })

    child.on('error', reject)

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new CommandError(`Command failed: exit ${code}`, code, stdout, stderr)
        )
      }
    })
  })
}

export function isGitRepo(): boolean {
  return existsSync(resolve(process.cwd(), '.git'))
}

export async function isBranchUpToDate(): Promise<{
  upToDate: boolean
  reason: string
}> {
  try {
    await runCmd('git', ['fetch'])

    const { stdout: status } = await runCmd('git', ['status', '-uno'])
    const statusText = status.trim()

    if (statusText.includes('Your branch is behind')) {
      return {
        upToDate: false,
        reason:
          'Your branch is behind the remote. Pull the latest changes first.',
      }
    }

    if (statusText.includes('have diverged')) {
      return {
        upToDate: false,
        reason:
          'Your branch has diverged from the remote. Resolve this before updating.',
      }
    }

    return { upToDate: true, reason: '' }
  } catch {
    return {
      upToDate: false,
      reason: 'Failed to determine git branch status.',
    }
  }
}

function formatFailure(err: unknown): string {
  if (err instanceof CommandError) {
    const output = [err.stdout, err.stderr]
      .map((stream) => stream.trim())
      .filter(Boolean)
      .join('\n\n')
    return output || err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export async function execAsync(
  cmd: string,
  args: string[],
  startMessage: string,
  errorMessage: string,
  successMessage: string
): Promise<boolean> {
  const s = spinner()
  s.start(startMessage)
  try {
    await runCmd(cmd, args)
    s.stop(successMessage)
    return true
  } catch (err) {
    s.stop(errorMessage)
    log.error(formatFailure(err))
    return false
  }
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

export function readPackageManagerField(): string | null {
  try {
    const pkg = readProjectPackageJson()
    return pkg.packageManager ?? null
  } catch {
    return null
  }
}

export function parsePackageManagerVersion(
  field: string | null,
  expectedName: string
): string | null {
  if (!field) return null
  const match = field.match(/^([^@]+)@([^+\s]+)/)
  if (!match) return null
  if (match[1] !== expectedName) return null
  return match[2]
}

export function readProjectPackageJson(): PackageJson {
  const packageJsonPath = resolve(process.cwd(), 'package.json')
  try {
    const content = readFileSync(packageJsonPath, 'utf-8')
    return JSON.parse(content) as PackageJson
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to read package.json: ${message}`)
  }
}

export function isPackageInstalled(
  packageJson: PackageJson,
  packageName: string
): boolean {
  return (
    packageName in (packageJson.dependencies ?? {}) ||
    packageName in (packageJson.devDependencies ?? {})
  )
}

export function isDevDependency(
  packageJson: PackageJson,
  packageName: string
): boolean {
  return packageName in (packageJson.devDependencies ?? {})
}

function parseVersion(version: string): {
  major: number
  minor: number
  patch: number
} {
  const cleaned = version.replace(/^[^0-9]*/, '')
  const [major, minor, patch] = cleaned.split('.').map(Number)
  return { major, minor, patch }
}

export async function getInstalledVersion(
  packageName: string
): Promise<string | null> {
  try {
    const packageJsonPath = resolve(
      process.cwd(),
      'node_modules',
      packageName,
      'package.json'
    )
    const content = readFileSync(packageJsonPath, 'utf-8')
    const pkg = JSON.parse(content) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

/**
 * Fetch all published versions of a package from the npm registry.
 * npm is used because it ships with every Node.js installation and both
 * pnpm and bun use the same registry under the hood.
 * Returns null on any error so callers degrade gracefully.
 */
async function fetchPublishedVersions(
  packageName: string
): Promise<string[] | null> {
  try {
    const { stdout } = await runCmd('npm', [
      'view',
      packageName,
      'versions',
      '--json',
    ])
    const parsed: unknown = JSON.parse(stdout)
    // npm returns a plain string when only one version has been published
    if (Array.isArray(parsed)) return parsed as string[]
    if (typeof parsed === 'string') return [parsed]
    return null
  } catch {
    return null
  }
}

export async function getNextMinorVersion(
  packageName: string,
  currentVersion: string
): Promise<string | null> {
  const { major, minor } = parseVersion(currentVersion)
  const targetMinor = minor + 1

  const versions = await fetchPublishedVersions(packageName)
  if (!versions) return null

  const candidates = versions
    .filter((v) => {
      const parsed = parseVersion(v)
      return (
        parsed.major === major &&
        parsed.minor === targetMinor &&
        !v.includes('-')
      )
    })
    .sort((a, b) => {
      const pa = parseVersion(a)
      const pb = parseVersion(b)
      return pa.patch - pb.patch
    })

  if (candidates.length === 0) return null
  return candidates[candidates.length - 1]
}

export async function getLatestVersion(
  packageName: string
): Promise<string | null> {
  try {
    const { stdout } = await runCmd('npm', ['view', packageName, 'version'])
    const v = stdout.trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

export async function getPnpmVersion(): Promise<string | null> {
  const fromField = parsePackageManagerVersion(
    readPackageManagerField(),
    'pnpm'
  )
  if (fromField) return fromField

  try {
    const { stdout } = await runCmd('pnpm', ['--version'])
    const v = stdout.trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

export function getMajor(version: string): number {
  return parseVersion(version).major
}

export async function getNextPatchVersion(
  packageName: string,
  currentVersion: string
): Promise<string | null> {
  const { major, minor, patch } = parseVersion(currentVersion)

  const versions = await fetchPublishedVersions(packageName)
  if (!versions) return null

  const candidates = versions
    .filter((v) => {
      const parsed = parseVersion(v)
      return (
        parsed.major === major &&
        parsed.minor === minor &&
        parsed.patch > patch &&
        !v.includes('-')
      )
    })
    .sort((a, b) => {
      const pa = parseVersion(a)
      const pb = parseVersion(b)
      return pa.patch - pb.patch
    })

  if (candidates.length === 0) return null
  return candidates[candidates.length - 1]
}
