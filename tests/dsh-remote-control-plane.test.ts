import { describe, expect, it } from 'vitest'
import { DshRemoteHttpControlPlane, type DshRemoteHttpRequester } from '../src/dsh-remote/control-plane.js'

class BindingRequester implements DshRemoteHttpRequester {
  async get(path: string): Promise<Record<string, unknown>> {
    expect(path).toBe('/api/v1/dsh-remote/bindings')
    return {
      bindings: [{
        binding: {
          binding_ref: 'binding_01', controller_credential_ref: 'controller_01',
          binding_revision: 3, status: 'active', scopes: ['session.history'],
          created_at: 1_700_000_000_000, last_used_at: 1_700_000_100_000,
        },
        desktop: { desktop_ref: 'desktop_01', display_name: 'MacBook' },
        controller: {
          credential_ref: 'controller_01', device_name: "Alice's iPhone",
          platform: 'ios', status: 'active',
        },
      }],
    }
  }

  async post(): Promise<Record<string, unknown>> {
    throw new Error('unexpected POST')
  }
}

describe('DshRemoteHttpControlPlane binding projection', () => {
  it('uses the controller device identity instead of the controlled desktop label', async () => {
    const plane = new DshRemoteHttpControlPlane(new BindingRequester())
    await expect(plane.listBindings()).resolves.toEqual([{
      bindingRef: 'binding_01', controllerCredentialRef: 'controller_01',
      controllerDisplayName: "Alice's iPhone", controllerPlatform: 'ios',
      revision: 3, status: 'active', scopes: ['session.history'],
      boundAtMillis: 1_700_000_000_000, lastUsedAtMillis: 1_700_000_100_000,
    }])
  })
})
