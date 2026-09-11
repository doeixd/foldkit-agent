/**
 * Phase 0 scratch probe against foldkit@0.158.2 and effect@4.0.0-rc.112.
 * Run from packages/mixins so the package's pinned peers resolve, not the
 * workspace root's possibly-different effect.
 *
 *   pnpm exec tsx probe/foldkit.ts
 *
 * Conclusions belong in DESIGN.md. This file is not public API.
 */
import { Context, Effect, Stream } from 'effect'
import { childAttributes, inertHtml as ih } from 'foldkit/html'
import {
  FOLDKIT_MOUNT_KEY,
  __clearRuntime,
  __htmlBuilder,
  __setRuntime,
} from '../node_modules/foldkit/dist/html/index.js'
import { isChildAttribute } from '../node_modules/foldkit/dist/html/childAttribute.js'
import type { MountAction } from 'foldkit/mount'
import { serializeHtml } from '../node_modules/foldkit/dist/experimental/server/serialize.js'

const h = __htmlBuilder<{ readonly _tag: 'A' } | { readonly _tag: 'B' }>()

const log = (label: string, value: unknown) => {
  console.log(`\n=== ${label} ===`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const vnodeData = (vnode: unknown): Record<string, unknown> => {
  const data = (vnode as { data?: Record<string, unknown> }).data
  if (data === undefined) throw new Error('vnode has no data')
  return data
}

const withRuntime = <A>(f: () => A): A => {
  __setRuntime(() => undefined, Context.empty())
  try {
    return f()
  } finally {
    __clearRuntime()
  }
}

const classDuplicate = () => {
  const vnode = ih.div([ih.Class('a b'), ih.Class('c')], [])
  const data = vnodeData(vnode)
  log('Class duplicate (last Class should replace, not merge)', data.class)
}

const styleDuplicate = () => {
  const vnode = ih.div(
    [ih.Style({ color: 'red', padding: '1px' }), ih.Style({ color: 'blue' })],
    [],
  )
  const data = vnodeData(vnode)
  log('Style duplicate (last Style should replace the whole object)', data.style)
}

const attributeTaggedShape = () => {
  const cls = ih.Class('field')
  const style = ih.Style({ display: 'grid' })
  const key = ih.Key('row-1')
  log('Attribute tagged shapes', { cls, style, key })
}

const eventChainObserved = () => {
  const seen: string[] = []
  __setRuntime(message => seen.push((message as { _tag: string })._tag), Context.empty())
  try {
    const vnode = h.button([h.OnClick({ _tag: 'A' }), h.OnClick({ _tag: 'B' })], ['x'])
    const on = vnodeData(vnode).on as { click?: (event: Event) => void }
    on.click?.(new Event('click'))
  } finally {
    __clearRuntime()
  }
  log('OnClick duplicate: dispatched tags', seen)
}

const mountAction = (name: string): MountAction<never> => ({
  name,
  f: () => Stream.empty,
})

const onMountDuplicate = () => {
  const vnode = withRuntime(() =>
    h.div([h.OnMount(mountAction('First')), h.OnMount(mountAction('Second'))], []),
  )
  const data = vnodeData(vnode)
  log('OnMount duplicate marker (FOLDKIT_MOUNT_KEY)', data[FOLDKIT_MOUNT_KEY])
  log('OnMount duplicate hook keys', Object.keys((data.hook as object) ?? {}))
}

const childAttributeShape = () => {
  const original = h.OnClick({ _tag: 'A' })
  const wrapped = withRuntime(() => childAttributes([original, h.Role('button')]))
  log(
    'childAttributes shape',
    wrapped.map(item => ({
      isChildAttribute: isChildAttribute(item),
      keys: Object.keys(item),
      brand: '__childAttribute' in item,
      attributeTag: (item as { attribute?: { _tag?: string } }).attribute?._tag,
      sameOnClickRef: (item as { attribute?: unknown }).attribute === original,
    })),
  )
}

const childAttributeDispatchPreserved = () => {
  const parentSeen: string[] = []
  const childSeen: string[] = []
  __setRuntime(message => parentSeen.push((message as { _tag: string })._tag), Context.empty())
  try {
    const childWrapped = (() => {
      __setRuntime(message => childSeen.push((message as { _tag: string })._tag), Context.empty())
      try {
        return childAttributes([h.OnClick({ _tag: 'A' })])
      } finally {
        __clearRuntime()
      }
    })()
    const vnode = h.button([...childWrapped, h.OnClick({ _tag: 'B' }), ih.Class('extra')], ['x'])
    const on = vnodeData(vnode).on as { click?: (event: Event) => void }
    on.click?.(new Event('click'))
    log('ChildAttribute + parent OnClick dispatches', { parentSeen, childSeen })
    log('ChildAttribute + extra Class', vnodeData(vnode).class)
  } finally {
    __clearRuntime()
  }
}

const ssrClassStyle = () => {
  const html = ih.div([ih.Class('a b'), ih.Style({ color: 'red' }), ih.Id('root')], ['hello'])
  log('serializeHtml of Class+Style+Id', serializeHtml(html))
  const replaced = ih.div(
    [ih.Class('a'), ih.Class('b'), ih.Style({ color: 'red' }), ih.Style({ padding: '1px' })],
    ['hello'],
  )
  log('serializeHtml of duplicate Class+Style', serializeHtml(replaced))
}

const streamMerge = async () => {
  const merged = Stream.mergeAll([Stream.make('a', 'b'), Stream.make('c')], {
    concurrency: 'unbounded',
  })
  const values = await Effect.runPromise(Stream.runCollect(merged))
  log('Stream.mergeAll unbounded', [...values])

  const failed = Stream.mergeAll([Stream.make(1), Stream.fail('boom'), Stream.make(2)], {
    concurrency: 'unbounded',
  })
  const result = await Effect.runPromise(Effect.result(Stream.runCollect(failed)))
  log('Stream.mergeAll with a failure (does not swallow)', {
    tag: result._tag,
    failure: result._tag === 'Failure' ? String(result.failure) : undefined,
  })
}

const main = async () => {
  attributeTaggedShape()
  classDuplicate()
  styleDuplicate()
  eventChainObserved()
  onMountDuplicate()
  childAttributeShape()
  childAttributeDispatchPreserved()
  ssrClassStyle()
  await streamMerge()
}

await main()
