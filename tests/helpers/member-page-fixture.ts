/** Existing UI scenarios use a single complete fixture page; paging/races have their own owner tests. */
export function memberPageFixture(call: (operation: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) {
  return async (operation: string, ...args: [params?: Record<string, unknown>, signal?: AbortSignal]) => {
    const [params, signal] = args
    if (operation === 'source.members.cached') return null
    if (operation === 'source.members.page') {
      const result = await call('source.members', { sourceRef: params?.sourceRef, activeOnly: true }, signal) as Record<string, unknown>
      return { ...result, hasMore: false, removedMemberRefs: [], presentationComplete: true }
    }
    return await call(operation, ...args)
  }
}
