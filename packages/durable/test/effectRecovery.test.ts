import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { cursor, makeJournal } from '../src/index.js'
import { document, effectKey, journalOptions, operation } from './fixtures/recoveryModel.js'

const worker = fileURLToPath(new URL('./fixtures/effectRecoveryWorker.ts', import.meta.url))

const runWorker = (journal: string, provider: string, phase: string, policy: string) =>
  new Promise<{ code: number | string; output: string; stderr: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', worker, journal, provider, phase, policy],
      {
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        if (error?.killed || error?.signal) return reject(error)
        resolve({ code: error?.code ?? 0, output: stdout, stderr })
      },
    )
  })

const providerState = (file: string) => {
  const db = new DatabaseSync(file)
  try {
    return {
      attempts: db
        .prepare('SELECT key FROM attempts ORDER BY rowid')
        .all()
        .map(row => row.key),
      deliveries: db
        .prepare('SELECT receipt, key FROM deliveries ORDER BY receipt')
        .all()
        .map(row => ({ ...row })),
    }
  } finally {
    db.close()
  }
}

describe('effect recovery after process termination', () => {
  it.for([
    {
      phase: 'after-append',
      policy: 'idempotent',
      status: undefined,
      before: 0,
      attempts: 1,
      deliveries: 1,
    },
    {
      phase: 'before-provider',
      policy: 'idempotent',
      status: 'pending',
      before: 0,
      attempts: 1,
      deliveries: 1,
    },
    {
      phase: 'after-provider',
      policy: 'idempotent',
      status: 'pending',
      before: 1,
      attempts: 2,
      deliveries: 1,
    },
    {
      phase: 'after-record',
      policy: 'idempotent',
      status: 'succeeded',
      before: 1,
      attempts: 1,
      deliveries: 1,
    },
    {
      phase: 'after-provider',
      policy: 'non-idempotent',
      status: 'pending',
      before: 1,
      attempts: 2,
      deliveries: 2,
    },
  ])(
    '$phase with $policy provider',
    { timeout: 45_000 },
    async ({ phase, policy, status, before, attempts, deliveries }) => {
      const directory = await mkdtemp(join(tmpdir(), 'foldkit-effect-recovery-'))
      const file = join(directory, 'journal.sqlite')
      const provider = join(directory, 'provider.sqlite')
      const key = effectKey(operation)
      try {
        const crashed = await runWorker(file, provider, phase, policy)
        expect(crashed.code, crashed.stderr).toBe(73)
        expect(crashed.output).toBe('')
        expect(providerState(provider)).toEqual({
          attempts: Array.from({ length: before }, () => key),
          deliveries: Array.from({ length: before }, (_, index) => ({ receipt: index + 1, key })),
        })
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const journal = yield* makeJournal(journalOptions(file))
              expect(yield* journal.read(document, cursor(0))).toEqual([
                { operation, opId: operation, sequence: 1, actorId: 'owner' },
              ])
              const record = Option.getOrElse(yield* journal.effect(key), () => undefined)
              expect(record).toEqual(
                status === undefined
                  ? undefined
                  : {
                      key,
                      status,
                      ...(status === 'succeeded' ? { result: { receipt: 1 } } : {}),
                    },
              )
            }),
          ),
        )

        // A fresh process retains no in-memory cache, provider state, or owner.
        const recovered = await runWorker(file, provider, 'recover', policy)
        expect(recovered.code, recovered.stderr).toBe(0)
        expect(JSON.parse(recovered.output)).toEqual([{ receipt: deliveries }])
        const expectedProvider = {
          attempts: Array.from({ length: attempts }, () => key),
          deliveries: Array.from({ length: deliveries }, (_, index) => ({
            receipt: index + 1,
            key,
          })),
        }
        expect(providerState(provider)).toEqual(expectedProvider)

        const replayed = await runWorker(file, provider, 'recover', policy)
        expect(replayed.code, replayed.stderr).toBe(0)
        expect(JSON.parse(replayed.output)).toEqual([{ receipt: deliveries }])
        expect(providerState(provider)).toEqual(expectedProvider)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
