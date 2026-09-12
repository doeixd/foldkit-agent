/**
 * The application as data.
 *
 * `Module.make` collects the contracts every package declared, in order, and
 * `validate` checks what the types cannot: that every contract belongs to this
 * application, that no two own the same Model path, that no Message is durable
 * in two sync contracts, and that no contract names a field or Message the
 * application does not have. `manifest` says who owns each Model field, which
 * is the "one owner per datum" rule made visible.
 */
import { Module } from 'foldkit-surface'
import { AppAgent } from './agent.js'
import { App, Board, Composer, Footer, Header, Overview } from './surface.js'
import { contract as sync } from './sync.js'

export const TodoModule = Module.make(App, [
  Header,
  Composer,
  Board,
  Footer,
  Overview,
  sync,
  AppAgent,
])

export const validate = () => Module.validate(TodoModule)
export const manifest = () => Module.manifest(TodoModule)
export const toMarkdown = () => Module.toMarkdown(TodoModule)
export const toMermaid = () => Module.toMermaid(TodoModule)
