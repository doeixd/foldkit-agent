import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { RemoteData } from '../src/index.js'

describe('RemoteData', () => {
  const label = (data: RemoteData<number>): string =>
    RemoteData.match(data, {
      Initial: () => 'initial',
      Loading: () => 'loading',
      Ready: value => `ready:${value}`,
      Refreshing: value => `refreshing:${value}`,
      Failed: (error, previous) =>
        `failed:${error._tag}:${Option.isSome(previous) ? previous.value : 'none'}`,
      NotFound: () => 'notfound',
    })

  it('matches every state', () => {
    expect(label({ _tag: 'Initial' })).toBe('initial')
    expect(label({ _tag: 'Loading' })).toBe('loading')
    expect(label({ _tag: 'Ready', value: 1 })).toBe('ready:1')
    expect(label({ _tag: 'Refreshing', value: 2 })).toBe('refreshing:2')
    expect(label({ _tag: 'Failed', error: { _tag: 'Boom', message: 'x' } })).toBe(
      'failed:Boom:none',
    )
    expect(label({ _tag: 'Failed', error: { _tag: 'Boom', message: 'x' }, previous: 3 })).toBe(
      'failed:Boom:3',
    )
    expect(label({ _tag: 'NotFound' })).toBe('notfound')
  })

  it('maps values and preserves failures', () => {
    expect(RemoteData.map({ _tag: 'Ready', value: 2 }, n => n + 1)).toEqual({
      _tag: 'Ready',
      value: 3,
    })
    expect(RemoteData.map({ _tag: 'NotFound' }, (n: number) => n + 1)).toEqual({
      _tag: 'NotFound',
    })
    expect(
      RemoteData.map(
        { _tag: 'Failed', error: { _tag: 'Boom', message: 'x' }, previous: 2 },
        n => n + 1,
      ),
    ).toEqual({ _tag: 'Failed', error: { _tag: 'Boom', message: 'x' }, previous: 3 })
  })
})
