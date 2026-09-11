/**
 * `Behavior` is a named set of interaction contributions attached to declared
 * Slots. It owns no state: attributes are built from the view's `input` and `h`
 * while resolving, so the Message universe is the view's. A stateful widget is
 * a Foldkit Submodel; a continuous element listener is a Mount; a network call
 * is Message -> update -> Command.
 */
import type { Attribute, ChildAttribute, HtmlBuilder } from 'foldkit/html'
import type { MountAction } from 'foldkit/mount'
import * as Capability from './capability.js'
import type { SlotContribution } from './contribution.js'
import { DiagnosticError, type DiagnosticCode } from './diagnostics.js'
import * as MetadataToken from './metadataToken.js'
import * as Mixin from './mixin.js'
import type { Mixin as MixinValue } from './mixin.js'
import type { Any as AnySlot, AttributeName, EventName, SlotCapability } from './slot.js'
import * as SlotView from './slotView.js'

export interface SlotRequirements {
  readonly capability?: SlotCapability
  readonly events?: ReadonlyArray<EventName>
  readonly attributes?: ReadonlyArray<AttributeName>
}

export interface BehaviorSlotOptions<Input, Message> {
  readonly requires?: SlotRequirements
  readonly attributes?: (context: {
    readonly input: Input
    readonly h: HtmlBuilder<Message>
  }) => ReadonlyArray<Attribute<Message> | ChildAttribute>
  readonly mount?: (input: Input) => MountAction<Message, any>
}

export type BehaviorSpec<Slots, Input, Message> = {
  readonly [K in keyof Slots]?: BehaviorSlotOptions<Input, Message>
}

export interface NamedBehavior<Slots, Input, Message> {
  readonly name?: string
  readonly spec: BehaviorSpec<Slots, Input, Message>
  readonly mixin: MixinValue<Message>
}

/** Identity helper; `forSlots` supplies the contextual `Input`/`Message`. */
export const slot = <Options extends BehaviorSlotOptions<any, any>>(options: Options): Options =>
  options

function fail(
  code: DiagnosticCode,
  message: string,
  slotName: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new DiagnosticError({
    source: 'mixins',
    code,
    severity: 'error',
    message,
    slot: slotName,
    ...(details === undefined ? {} : { details }),
  })
}

const validateRequirements = (
  name: string,
  slot: AnySlot,
  requirements: SlotRequirements,
): void => {
  if (
    requirements.capability !== undefined &&
    !Capability.extendsCapability(slot.capability, requirements.capability)
  ) {
    fail(
      'mixins:capability-mismatch',
      `Behavior requires capability "${MetadataToken.nameOf(requirements.capability)}" on slot "${name}", which has "${MetadataToken.nameOf(slot.capability)}"`,
      name,
      { required: MetadataToken.nameOf(requirements.capability) },
    )
  }
  for (const event of requirements.events ?? []) {
    const eventName = MetadataToken.nameOf(event)
    if (!slot.events.some(allowed => MetadataToken.nameOf(allowed) === eventName)) {
      fail(
        'mixins:unsupported-event',
        `Behavior requires event "${eventName}" on slot "${name}", which does not publish it`,
        name,
        { event: eventName },
      )
    }
  }
  for (const attribute of requirements.attributes ?? []) {
    const attributeName = MetadataToken.nameOf(attribute)
    if (!slot.attributes.some(allowed => MetadataToken.nameOf(allowed) === attributeName)) {
      fail(
        'mixins:unsupported-attribute',
        `Behavior requires attribute "${attributeName}" on slot "${name}", which does not publish it`,
        name,
        { attribute: attributeName },
      )
    }
  }
}

export const forSlots =
  <Slots>(slots: Slots) =>
  <Input, Message>(
    spec: BehaviorSpec<Slots, Input, Message>,
    options?: { readonly name?: string },
  ): NamedBehavior<Slots, Input, Message> => {
    const source = slots as unknown as Record<string, AnySlot>
    const contributions: Record<string, SlotContribution<Message>> = {}
    for (const [name, slotOptions] of Object.entries(
      spec as Record<string, BehaviorSlotOptions<Input, Message> | undefined>,
    )) {
      const target = source[name]
      if (target === undefined) {
        fail('mixins:unknown-slot', `Behavior targets unknown slot "${name}"`, name)
      }
      if (slotOptions?.requires !== undefined) {
        validateRequirements(name, target, slotOptions.requires)
      }
      const attributes = slotOptions?.attributes
      const mount = slotOptions?.mount
      if (attributes === undefined && mount === undefined) continue
      contributions[name] = context => ({
        ...(attributes === undefined
          ? {}
          : { attributes: attributes({ input: context.input as Input, h: context.h }) }),
        ...(mount === undefined ? {} : { mounts: [mount(context.input as Input)] }),
      })
    }
    return Object.freeze({
      ...(options?.name === undefined ? {} : { name: options.name }),
      spec,
      mixin: Mixin.dynamic<Message>(options?.name ?? 'Behavior', contributions),
    })
  }

export const attach =
  <BehaviorSlots, Message, Input>(behavior: NamedBehavior<BehaviorSlots, Input, Message>) =>
  <ViewSlots>(
    view: SlotView.SlotView<ViewSlots, Input, Message>,
  ): SlotView.SlotView<ViewSlots, Input, Message> =>
    SlotView.attach(behavior.mixin)(view)

export const Behavior = { slot, forSlots, attach } as const
