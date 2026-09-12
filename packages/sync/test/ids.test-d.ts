/**
 * Branded position contract. Type-checked but not executed.
 */
import { localSequence, sequence, type LocalSequence, type Sequence } from '../src/index.js'

const seq: Sequence = sequence(0)
const local: LocalSequence = localSequence(1)

// @ts-expect-error a committed position is not a replica's own counter
const _badLocal: LocalSequence = seq
// @ts-expect-error a replica's own counter is not a committed position
const _badSeq: Sequence = local
// @ts-expect-error a plain number is not a committed position
const _plain: Sequence = 0

void _badLocal
void _badSeq
void _plain
