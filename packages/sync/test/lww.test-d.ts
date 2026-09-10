import { Schema } from 'effect'
import { lwwRegister } from '../src/index.js'

const Count = lwwRegister(Schema.NumberFromString)
const stamp = { counter: 1, replicaId: 'a' }
const result: number = Count.merge({ stamp, value: 1 }, { stamp, value: 1 }).value
Schema.encodeSync(Count.schema)({ stamp, value: result })
// @ts-expect-error merge consumes decoded values
Count.merge({ stamp, value: '1' }, { stamp, value: 1 })
// @ts-expect-error value codecs retain their encoded type
const encoded: typeof Count.schema.Encoded = { stamp, value: 1 }
// @ts-expect-error replica identity is required
Count.merge({ stamp: { counter: 1 }, value: 1 }, { stamp, value: 1 })
