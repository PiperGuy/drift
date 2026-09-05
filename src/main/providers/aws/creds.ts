import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'

/**
 * AWS access for the ECS and Secrets Manager adapters. Drift never stores an
 * AWS key: every client is built from the SDK's standard credential provider
 * chain (environment, shared config/credentials profiles, SSO sessions,
 * container/instance roles). Only the region and profile NAME are persisted.
 */
export type AwsAuth = { region: string; profile: string | null }

export const credentials = (auth: AwsAuth): AwsCredentialIdentityProvider =>
  fromNodeProviderChain({ profile: auth.profile ?? undefined })

/** Profile names from ~/.aws/config (`[profile x]`, `[default]`) and ~/.aws/credentials (`[x]`). */
export async function awsProfiles(dir = join(homedir(), '.aws')): Promise<string[]> {
  const out = new Set<string>()
  const read = async (file: string, re: RegExp): Promise<void> => {
    let text: string
    try {
      text = await readFile(join(dir, file), 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      const m = re.exec(line)
      if (m) out.add(m[1].trim())
    }
  }
  await read('config', /^\s*\[\s*(?:profile\s+)?([^\]]+?)\s*\]\s*$/)
  await read('credentials', /^\s*\[\s*([^\]]+?)\s*\]\s*$/)
  return [...out].filter((p) => !p.startsWith('sso-session ') && !p.startsWith('services ')).sort()
}

/** One useful, value-safe message per SDK failure family. */
export function awsError(e: unknown, context: string, profile: string | null): Error {
  const err = e as {
    name?: string
    message?: string
    code?: string
    $metadata?: { httpStatusCode?: number }
  }
  const name = err.name ?? ''
  const msg = (err.message ?? '').replace(/\s+/g, ' ').slice(0, 300)
  const who = profile ? `profile ${profile}` : 'the default credential chain'
  const login = profile ? `aws sso login --profile ${profile}` : 'aws sso login'
  const mk = (m: string): Error => new Error(`${context}: ${m}`)
  if (name === 'CredentialsProviderError' || /Could not load credentials/i.test(msg))
    return mk(
      `No AWS credentials for ${who}. Run \`aws configure\` or \`${login}\`, or set AWS_PROFILE.`
    )
  if (/ExpiredToken/i.test(name) || /token.*expired|expired.*token|session has expired/i.test(msg))
    return mk(`AWS credentials for ${who} have expired. Run \`${login}\` and retry.`)
  if (
    name === 'UnrecognizedClientException' ||
    name === 'InvalidSignatureException' ||
    name === 'InvalidClientTokenId'
  )
    return mk(`AWS rejected the credentials for ${who} (${name}). Check the profile and region.`)
  if (/AccessDenied|UnauthorizedException|NotAuthorized/i.test(name))
    return mk(`access denied for ${who}: ${msg || name}`)
  if (/NotFound/i.test(name)) return mk(`not found (${name}${msg ? `: ${msg}` : ''})`)
  if (
    /Throttling|TooManyRequests|LimitExceeded/i.test(name) ||
    err.$metadata?.httpStatusCode === 429
  )
    return mk('AWS rate limit hit. Retry in a moment.')
  if (name === 'DecryptionFailure')
    return mk('the secret is encrypted with a KMS key you cannot use (DecryptionFailure).')
  if (
    /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)$/.test(err.code ?? '') ||
    name === 'TimeoutError'
  )
    return mk(
      `could not reach AWS in this region (${err.code ?? name}). Check the network and the region.`
    )
  return mk(msg || name || 'unknown AWS error')
}

/** Run one SDK call, translating its failure. */
export async function aws<T>(context: string, auth: AwsAuth, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    throw awsError(e, context, auth.profile)
  }
}
