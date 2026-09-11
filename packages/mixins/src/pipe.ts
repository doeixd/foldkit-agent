/** Ported from `effect-atom-jsx/src/View.ts` `pipeSelf`. */
export const pipeSelf = (self: unknown, fns: ReadonlyArray<(value: any) => any>): unknown =>
  fns.reduce((acc, fn) => fn(acc), self)

export type Pipeable<Self> = {
  pipe(): Self
  pipe(...fns: ReadonlyArray<(self: Self) => Self>): Self
  pipe<A>(ab: (self: Self) => A): A
  pipe<A, B>(ab: (self: Self) => A, bc: (a: A) => B): B
  pipe<A, B, C>(ab: (self: Self) => A, bc: (a: A) => B, cd: (b: B) => C): C
}
