import type { Store } from '../store'
import type { ProviderConnectResult, ProviderConnectSpec } from '@shared/channels'
import { connectVercel, registerVercel } from './vercel'
import { connectGithub, registerGithub } from './github'
import { connectRailway, registerRailway } from './railway'
import { connectRender, registerRender } from './render'
import { connectDokploy, registerDokploy } from './dokploy'
import { connectCoolify, registerCoolify } from './coolify'
import { connectSecretsManager, registerSecretsManager } from './aws/sm'
import { connectEcs, registerEcs } from './aws/ecs'

/** Register every read-only provider backend with src/main/fs.ts. Called once at startup. */
export function registerProviders(store: Store): void {
  registerVercel(store)
  registerGithub(store)
  registerRailway(store)
  registerRender(store)
  registerDokploy(store)
  registerCoolify(store)
  registerSecretsManager(store)
  registerEcs(store)
}

/** Preflight + create the connection + return the root. Credentials never come back. */
export function connectProvider(
  store: Store,
  spec: ProviderConnectSpec
): Promise<ProviderConnectResult> {
  switch (spec.provider) {
    case 'vercel':
      return connectVercel(store, spec)
    case 'github':
      return connectGithub(store, spec)
    case 'railway':
      return connectRailway(store, spec)
    case 'render':
      return connectRender(store, spec)
    case 'dokploy':
      return connectDokploy(store, spec)
    case 'coolify':
      return connectCoolify(store, spec)
    case 'aws-sm':
      return connectSecretsManager(store, spec)
    case 'ecs':
      return connectEcs(store, spec)
  }
}
