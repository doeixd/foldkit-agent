/**
 * What every producer shares.
 *
 * `Surface.application` builds one reference tree from the Model Schema;
 * `Surface.pick` derives projections from it. The sync slice and the agent
 * context are selections over this, not separate declarations.
 */
import { Surface } from 'foldkit-surface'
import { Message, Model, initialModel, update } from './app.js'

export const App = Surface.application({ Model, Message, initial: initialModel, update })

/** The replicated slice: just the todos. */
export const Todos = Surface.pick(App.fields.todos)

/** What an agent may see: the board, without the per-device composer state. */
export const AgentContext = Surface.pick(App.fields.todos, App.fields.filter)
