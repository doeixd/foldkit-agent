/**
 * Relation values on the wire and in the store: a ref key (`"Entity:id"`), a
 * nullable ref key, an array of ref keys, or a page of ref keys. The planner
 * follows them into the store; the server follows them into the next read.
 */
import type { Schema } from 'effect'
import type { RelationRequirement } from 'foldkit-surface'

export interface RefParts {
  readonly entity: string
  readonly id: string
}

/** A page of refs as the wire and the store hold it. */
export interface RefPageValue {
  readonly refs: ReadonlyArray<string>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

/** Marks the codec `Entity.ref`/`Entity.refPage` produce, so a Selection can tell the field's shape. */
export const RelationAnnotation = 'foldkitRemoteRelation'
/** The target entity's name on the same codec, so a nested selection of another entity is refused. */
export const RelationEntityAnnotation = 'foldkitRemoteRelationEntity'

export type RelationKind = 'one' | 'many' | 'page'

export interface RelationShape {
  readonly kind: RelationKind
  readonly nullable: boolean
  readonly entity: string
}

/** Splits a ref key (`"Entity:id"`, the store key too) back into its parts. */
export const refParts = (encoded: string): RefParts => {
  const separator = encoded.indexOf(':')
  return separator === -1
    ? { entity: encoded, id: '' }
    : { entity: encoded.slice(0, separator), id: encoded.slice(separator + 1) }
}

/**
 * The refs a relation value carries, in order. Anything that is not a ref key,
 * an array of them, or a page of them contributes nothing.
 */
export const refsIn = (value: unknown): ReadonlyArray<RefParts> => {
  if (typeof value === 'string') return [refParts(value)]
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').map(refParts)
  if (value !== null && typeof value === 'object') {
    const refs = (value as { readonly refs?: unknown }).refs
    if (Array.isArray(refs)) return refs.filter(item => typeof item === 'string').map(refParts)
  }
  return []
}

/** The refs in a relation value that name the relation's target entity, and no other. */
export const targetsOf = (value: unknown, relation: RelationRequirement): ReadonlyArray<RefParts> =>
  refsIn(value).filter(ref => ref.entity === relation.entity)

export const isRefPage = (value: unknown): value is RefPageValue => {
  if (value === null || typeof value !== 'object') return false
  const page = value as Record<string, unknown>
  return (
    Array.isArray(page.refs) &&
    page.refs.every(ref => typeof ref === 'string') &&
    typeof page.hasNext === 'boolean' &&
    typeof page.hasPrevious === 'boolean'
  )
}

interface AstLike {
  readonly _tag: string
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
  readonly types?: ReadonlyArray<AstLike> | undefined
  readonly rest?: ReadonlyArray<AstLike> | undefined
}

/**
 * The relation shape an entity field schema declares: a ref (`one`), a nullable
 * ref, an array of refs (`many`), or a page of refs (`page`). `undefined` for a
 * scalar field, which cannot take a nested selection.
 */
export const relationShape = (schema: Schema.Top): RelationShape | undefined =>
  shapeOf(schema.ast as unknown as AstLike, false)

const shapeOf = (ast: AstLike, nullable: boolean): RelationShape | undefined => {
  const annotated = ast.annotations?.[RelationAnnotation]
  if (annotated === 'one' || annotated === 'page') {
    return {
      kind: annotated,
      nullable,
      entity: String(ast.annotations?.[RelationEntityAnnotation]),
    }
  }
  if (ast._tag === 'Arrays') {
    const item = ast.rest?.[0]
    const inner = item === undefined ? undefined : shapeOf(item, false)
    return inner?.kind === 'one' ? { kind: 'many', nullable, entity: inner.entity } : undefined
  }
  if (ast._tag === 'Union') {
    const members = ast.types ?? []
    const optional = members.some(member => member._tag === 'Null' || member._tag === 'Undefined')
    for (const member of members) {
      const shape = shapeOf(member, optional)
      if (shape !== undefined) return shape
    }
  }
  return undefined
}
