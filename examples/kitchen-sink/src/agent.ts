/**
 * The agent contract for the kitchen-sink application.
 *
 * It reuses the application's own Messages: every capability is a Message
 * `update` already knows how to handle, and every read is a Surface projection.
 * The adapters (`foldkit-agent-webmcp`, `-mcp`, `-a2a`, `-native`) turn this one
 * contract into their respective surfaces.
 */
import { Agent } from 'foldkit-agent'
import { Projection, Surface } from 'foldkit-surface'
import { Schema } from 'effect'
import { App, Message } from './stack.js'

/** Who is calling the agent. A real application resolves this from a session. */
export interface AgentPrincipal {
  readonly canWrite: boolean
}

const BoardAgent = Agent.forApplication(App).withPrincipal<AgentPrincipal>()

export const AppAgent = BoardAgent.make({
  // What an agent may see: the replicated notes and the current selection.
  context: Projection.pick(App.fields.notes, App.fields.selectedNoteId),

  messages: BoardAgent.expose(Message, {
    RequestedCreateNote: 'Create a note',
    RequestedRenameNote: { name: 'rename_note', description: 'Rename an existing note' },
    SelectedNote: 'Select a note, making the capabilities that act on one available',
  }),
})

export const bindAgent = BoardAgent.bind
