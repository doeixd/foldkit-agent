/**
 * Request policies: how a read treats fields the store already holds. A policy
 * compiles to planner options; it is not a second cache. `Remote.observe` and
 * `Remote.prefetch` take one, and the planner itself stays pure and
 * time-injected.
 */
import type { PlanOptions } from './plan.js'

export type RemotePolicy =
  /** Fetch only fields the store lacks (missing, stale, or re-windowed). */
  | { readonly _tag: 'CacheFirst' }
  /**
   * Keep present values visible, read them as `Refreshing`, and refetch an
   * entry older than `maxAge` milliseconds.
   */
  | { readonly _tag: 'StaleWhileRevalidate'; readonly maxAge: number }
  /** Fetch every selected field regardless of coverage; cached values stay visible meanwhile. */
  | { readonly _tag: 'NetworkOnly' }

export const RemotePolicy = {
  cacheFirst: { _tag: 'CacheFirst' } as RemotePolicy,

  staleWhileRevalidate: (options: { readonly maxAge: number }): RemotePolicy => ({
    _tag: 'StaleWhileRevalidate',
    maxAge: options.maxAge,
  }),

  networkOnly: { _tag: 'NetworkOnly' } as RemotePolicy,

  /** The planner options a policy compiles to at `now`. */
  toPlan: (policy: RemotePolicy, now: number): PlanOptions => {
    switch (policy._tag) {
      case 'CacheFirst':
        return {}
      case 'StaleWhileRevalidate':
        return { freshness: { now, freshness: policy.maxAge } }
      case 'NetworkOnly':
        return { force: true }
    }
  },

  /**
   * Whether a read under this policy may refetch fields the store already
   * holds, so an observer marks them stale (read as `Refreshing`) while the
   * request is pending.
   */
  refreshes: (policy: RemotePolicy): boolean => policy._tag !== 'CacheFirst',
}
