/**
 * The view. It is derived entirely from the Model and only ever emits Messages,
 * so the human and the agent drive the same machine. No component owns state.
 *
 * `toMessage` lifts an app Message into whatever universe the host renders in;
 * the runtime uses it to wrap events so it can route durable ones through the
 * replica.
 */
import type { Document, HtmlBuilder } from 'foldkit/html'
import { Message, type Model, counts, visibleTodos } from './app.js'

const filters = ['all', 'active', 'completed'] as const

const buttonClass = (active: boolean): string => (active ? 'filter filter--active' : 'filter')

export const view = <Msg>(
  model: Model,
  h: HtmlBuilder<Msg>,
  toMessage: (message: Message) => Msg,
): Document => {
  const tally = counts(model)
  return {
    title: 'Todos',
    body: h.div(
      [h.Class('app')],
      [
        h.header(
          [h.Class('app__header')],
          [
            h.h1([h.Class('app__title')], ['Todos']),
            h.p(
              [h.Class('app__subtitle')],
              [`${tally.active} active · ${tally.completed} completed`],
            ),
          ],
        ),

        ...(model.lastError === null ? [] : [h.p([h.Class('app__error')], [model.lastError])]),

        h.form(
          [
            h.Class('app__composer'),
            h.OnSubmit(
              toMessage(Message.SubmittedTodo({ id: crypto.randomUUID(), title: model.draft })),
            ),
          ],
          [
            h.input([
              h.Class('app__input'),
              h.Type('text'),
              h.Placeholder('What needs doing?'),
              h.Value(model.draft),
              h.OnInput(value => toMessage(Message.DraftChanged({ value }))),
            ]),
            h.button(
              [h.Class('app__add'), h.Type('submit'), h.Disabled(model.draft.trim() === '')],
              ['Add'],
            ),
          ],
        ),

        h.nav(
          [h.Class('app__filters')],
          filters.map(filter =>
            h.button(
              [
                h.Class(buttonClass(model.filter === filter)),
                h.OnClick(toMessage(Message.FilterSelected({ filter }))),
              ],
              [filter],
            ),
          ),
        ),

        h.ul(
          [h.Class('app__list')],
          visibleTodos(model).map(todo =>
            h.li(
              [h.Class(todo.completed ? 'item item--done' : 'item'), h.Key(todo.id)],
              [
                h.button(
                  [
                    h.Class('item__toggle'),
                    h.OnClick(toMessage(Message.ToggledTodo({ id: todo.id }))),
                  ],
                  [todo.completed ? '✓' : '○'],
                ),
                h.span([h.Class('item__title')], [todo.title]),
                h.button(
                  [
                    h.Class('item__delete'),
                    h.OnClick(toMessage(Message.DeletedTodo({ id: todo.id }))),
                  ],
                  ['×'],
                ),
              ],
            ),
          ),
        ),

        h.footer(
          [h.Class('app__footer')],
          [
            h.span([], [visibleTodos(model).length === 0 ? 'Nothing here' : '']),
            h.button(
              [
                h.Class('app__clear'),
                h.Disabled(tally.completed === 0),
                h.OnClick(toMessage(Message.ClearedCompleted({}))),
              ],
              ['Clear completed'],
            ),
          ],
        ),
      ],
    ),
  }
}
