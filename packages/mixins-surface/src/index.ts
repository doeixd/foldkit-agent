/**
 * `foldkit-mixins-surface` — the bridge between a `foldkit-surface` Surface and
 * a `foldkit-mixins` SlotView. It creates no state and no rendering machinery:
 * it only narrows the projected Model and Message subset before the core
 * resolver runs.
 */
export * as SurfaceView from './surfaceView.js'
export { define, describe, inspect, toMarkdown, toRenderer } from './surfaceView.js'
export type { SurfaceViewDescription, SurfaceViewInspection } from './surfaceView.js'
