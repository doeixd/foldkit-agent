import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as CalendarUi from '@foldkit/ui/calendar'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { Calendar, CalendarSlots, type ResolvedCalendar, type ResolvedDays } from '../src/index.js'

type CalendarMixins = ReadonlyArray<MixinValue<CalendarUi.Message> | MixinValue<never>>

interface Captured {
  readonly render: CalendarUi.CalendarAttributes
  readonly resolved: ResolvedCalendar<CalendarUi.Message>
}

/**
 * `Calendar.view` publishes its groups through `childAttributes`, which throws
 * outside a runtime frame. `Scene.scene` supplies that frame and the real `h`,
 * so `toView` receives real ChildAttributes rather than a synthetic brand.
 */
const runCalendar = (mixins: CalendarMixins, capture: (captured: Captured) => void): void => {
  Scene.scene(
    {
      update: CalendarUi.update,
      view: (model, h) =>
        CalendarUi.view(
          model,
          {
            maybeSelectedDate: Option.none(),
            toView: render => {
              const resolved = Calendar.resolve(render, mixins, { input: undefined, h })
              capture({ render, resolved })
              return h.div([...resolved.root], [h.div([...resolved.grid], [])])
            },
          },
          h,
        ),
    },
    Scene.given(CalendarUi.init({ id: 'test-calendar', today: { year: 2026, month: 8, day: 11 } })),
  )
}

const days = (resolved: ResolvedCalendar<CalendarUi.Message>): ResolvedDays<CalendarUi.Message> => {
  if (resolved._tag !== 'Days') throw new Error(`expected Days, got ${resolved._tag}`)
  return resolved
}

const holds = (
  attributes: SlotAttributes<CalendarUi.Message>,
  child: SlotAttributes<CalendarUi.Message>[number],
): boolean => attributes.includes(child)

const classValue = (attributes: SlotAttributes<CalendarUi.Message>): string | undefined => {
  for (const attribute of attributes) {
    if (
      typeof attribute === 'object' &&
      attribute !== null &&
      '_tag' in attribute &&
      (attribute as { readonly _tag: string })._tag === 'Class'
    ) {
      return (attribute as { readonly value: string }).value
    }
  }
  return undefined
}

const diagnosticFrom = (run: () => void): Diagnostics.Diagnostic | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    if (error instanceof Diagnostics.DiagnosticError) return error.diagnostic
    throw error
  }
}

describe('Calendar adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runCalendar([], value => {
      captured = value
    })
    const view = captured!
    expect(view.render._tag).toBe('Days')
    const base = view.render as CalendarUi.DaysModeAttributes
    const resolved = days(view.resolved)
    expect(Object.hasOwn(base.grid[0] as object, '__childAttribute')).toBe(true)
    for (const child of base.root) expect(holds(resolved.root, child)).toBe(true)
    for (const child of base.grid) expect(holds(resolved.grid, child)).toBe(true)
    for (const child of base.previousMonthButton) {
      expect(holds(resolved.previousMonthButton, child)).toBe(true)
    }
    for (const child of base.headerRow) expect(holds(resolved.headerRow, child)).toBe(true)
    for (const child of base.columnHeaders[0]!.attributes) {
      expect(holds(resolved.columnHeaders[0]!.attributes, child)).toBe(true)
    }
    const baseCell = base.weeks[0]!.cells[0]!
    const resolvedCell = resolved.weeks[0]!.cells[0]!
    for (const child of base.weeks[0]!.attributes) {
      expect(holds(resolved.weeks[0]!.attributes, child)).toBe(true)
    }
    for (const child of baseCell.cellAttributes) {
      expect(holds(resolvedCell.cellAttributes, child)).toBe(true)
    }
    for (const child of baseCell.buttonAttributes) {
      expect(holds(resolvedCell.buttonAttributes, child)).toBe(true)
    }
  })

  it('styles every day button without rebuilding its ChildAttributes', () => {
    const DayStyle = Style.forSlots(CalendarSlots)({ dayButton: Style.class('day') })
    let captured: Captured | undefined
    runCalendar([DayStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    const base = view.render as CalendarUi.DaysModeAttributes
    const resolved = days(view.resolved)
    for (let week = 0; week < base.weeks.length; week++) {
      for (let cell = 0; cell < base.weeks[week]!.cells.length; cell++) {
        const baseCell = base.weeks[week]!.cells[cell]!
        const resolvedCell = resolved.weeks[week]!.cells[cell]!
        for (const child of baseCell.buttonAttributes) {
          expect(holds(resolvedCell.buttonAttributes, child)).toBe(true)
        }
        expect(classValue(resolvedCell.buttonAttributes)).toBe('day')
      }
    }
  })

  it('refuses a Behavior that takes over the previous-month click', () => {
    const diagnostic = diagnosticFrom(() => {
      const Steal = Behavior.forSlots(CalendarSlots)<undefined, CalendarUi.Message>({
        previousMonthButton: Behavior.slot({
          requires: { events: [Event.Click] },
          attributes: ({ h }: { readonly h: HtmlBuilder<CalendarUi.Message> }) => [
            h.OnClick(CalendarUi.Message.ClickedPreviousMonthButton()),
          ],
        }),
      })
      runCalendar([Steal.mixin], () => {})
    })
    expect(diagnostic?.code).toBe('mixins:event-conflict')
  })
})
