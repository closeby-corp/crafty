/**
 * Where a credential comes from: the environment, or the target written in the
 * config file. There is no store to read or write - a credential is either
 * exported (CI, or beside `bkt`) or written in the file, and `crafty config show`
 * says which one a target ended up with.
 */
import { registerSecret } from 'crafty'
import { envName } from './targets.ts'
import type { Env } from './targets.ts'

/** `grafana-bi` -> `OPS_SECRET_GRAFANA_BI`, the variable that may hold it. */
export function secretEnvName(name: string): string {
  return `OPS_SECRET_${envName(name)}`
}

/**
 * `bkt` already keeps a Bitbucket API token and a Jira token in the environment,
 * so those two names win over everything: the CLI stays drop-in next to it.
 */
const LEGACY_ENV: Record<string, string> = { bitbucket: 'BITBUCKET_API_TOKEN', jira: 'JIRA_API_TOKEN' }

/** Where a credential came from. */
export type CredentialSource = 'legacy-env' | 'env' | 'config'

export interface Credential {
  value: string
  source: CredentialSource
  /** The variable it came from, when it came from one. */
  from?: string
}

/** What a target says about its own credential. */
export interface TargetCredential {
  /** The name of the environment variable that may hold it. */
  secret?: string
  /** The value itself, written in the file. */
  password?: string
  token?: string
}

/**
 * Resolution order: the legacy `bkt` variable, then `OPS_SECRET_<SECRET>` for a
 * target that names a `secret:`, then the value written in the file. The
 * environment beats the file so CI can inject a credential without touching it.
 */
export function targetCredential(
  kind: string,
  credential: TargetCredential,
  env: Env = process.env,
): Credential | null {
  const legacy = LEGACY_ENV[kind]
  if (legacy !== undefined) {
    const value = env[legacy]
    if (value !== undefined && value !== '') {
      registerSecret(value)
      return { value, source: 'legacy-env', from: legacy }
    }
  }

  const secretName = credential.secret
  if (secretName !== undefined && secretName !== '') {
    const variable = secretEnvName(secretName)
    const value = env[variable]
    if (value !== undefined && value !== '') {
      registerSecret(value)
      return { value, source: 'env', from: variable }
    }
  }

  const inline = credential.password ?? credential.token
  if (inline !== undefined && inline !== '') {
    registerSecret(inline)
    return { value: inline, source: 'config' }
  }

  return null
}
