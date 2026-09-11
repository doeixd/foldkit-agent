import { describe, expect, it } from 'vitest'
import { Effect, Result, Stream } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { Scene } from 'foldkit/test'
import { liveViewStateChanges, type MountAction } from 'foldkit/mount'
import { Behavior, Capability, Resolver, Slot, SlotView, Slots } from '../src/index.js'

type TestMessage = { readonly _tag: 'GotA' } | { readonly _tag: 'GotB' }

const emitA: MountAction<TestMessage> = { name: 'A', f: () => Stream.succeed({ _tag: 'GotA' }) }
const emitB: MountAction<TestMessage> = { name: 'B', f: () => Stream.succeed({ _tag: 'GotB' }) }

const collect = <A>(stream: Stream.Stream<A, unknown>): Promise<ReadonlyArray<A>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map(chunk => Array.from(chunk))))

/** Resolve two per-slot contributions and return the one composed OnMount. */
const composed = (
  mounts: ReadonlyArray<MountAction<TestMessage, any>>,
): MountAction<TestMessage, any> => {
  const attributes = Resolver.resolve(
    [],
    mounts.map(mount => ({ mounts: [mount] })),
    { slot: 'root' },
  )
  const onMount = attributes.find(
    attribute => (attribute as { readonly _tag?: string })._tag === 'OnMount',
  ) as { readonly action: MountAction<TestMessage, any> } | undefined
  if (onMount === undefined) throw new Error('expected a composed OnMount')
  return onMount.action
}

const element = {} as Element

describe('Mount composition at runtime', () => {
  it('merges the streams of every composed mount', async () => {
    const mount = composed([emitA, emitB])
    expect(mount.name).toBe('Mixins[root](A,B)')
    expect(await collect(mount.f(element, liveViewStateChanges))).toEqual(
      expect.arrayContaining([{ _tag: 'GotA' }, { _tag: 'GotB' }]),
    )
  })

  it('fails the merge when one mount stream fails', async () => {
    const failing: MountAction<TestMessage, Error> = {
      name: 'Failing',
      f: () => Stream.fail(new Error('boom')),
    }
    const mount = composed([failing, emitA])
    const result = await Effect.runPromise(
      Effect.result(Stream.runCollect(mount.f(element, liveViewStateChanges))),
    )
    expect(Result.isFailure(result)).toBe(true)
  })

  it('is observed by Scene as exactly one Mount', () => {
    const RootSlots = Slots.define({ root: Slot.make({ capability: Capability.Container }) })
    const ObserveA = Behavior.forSlots(RootSlots)<undefined, TestMessage>({
      root: Behavior.slot({ mount: () => emitA }),
    })
    const ObserveB = Behavior.forSlots(RootSlots)<undefined, TestMessage>({
      root: Behavior.slot({ mount: () => emitB }),
    })
    const View = SlotView.define(
      RootSlots,
      (_input: undefined, slots, h: HtmlBuilder<TestMessage>) => h.div(slots.root.attrs(), []),
    ).pipe(Behavior.attach(ObserveA), Behavior.attach(ObserveB))

    Scene.scene(
      {
        update: (model: undefined, _message: TestMessage) => ({ model }),
        view: (model, h) => View(model, h),
      },
      Scene.given(undefined),
      Scene.Mount.expectExact({ name: 'Mixins[root](A,B)' }),
      Scene.Mount.resolve({ name: 'Mixins[root](A,B)' }, { _tag: 'GotA' }),
    )
  })
})
