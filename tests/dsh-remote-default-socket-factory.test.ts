import { describe, expect, it } from 'vitest'
import { dshRemoteRealtimeEndpoint } from '../src/dsh-remote/default-socket-factory.js'

describe('DSH remote default socket factory', () => {
  it('derives the frozen websocket path without putting credentials in the URL', () => {
    expect(dshRemoteRealtimeEndpoint('https://jotmo.senguo.me/'))
      .toBe('wss://jotmo.senguo.me/api/v1/realtime/connect')
  })

  it.each([
    'http://jotmo.senguo.me/',
    'https://user:password@jotmo.senguo.me/',
    'https://jotmo.senguo.me/api',
    'https://jotmo.senguo.me/?token=unsafe',
  ])('rejects an unsafe service origin: %s', (origin) => {
    expect(() => dshRemoteRealtimeEndpoint(origin)).toThrow(/credential-free HTTPS auth origin/)
  })
})
