import { Schema } from 'effect'

/** A storage or database failure, not something the caller did. */
export class JournalError extends Schema.TaggedError<JournalError>()('JournalError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The supplied operation did not satisfy the application's codec or checks. */
export class InvalidOperationError extends Schema.TaggedError<InvalidOperationError>()(
  'InvalidOperationError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** A read requested a position past the committed cursor. */
export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>()(
  'InvalidCursorError',
  {
    after: Schema.Number,
    cursor: Schema.Number,
    message: Schema.String,
  },
) {}

/** A read requested a position compaction has already discarded. */
export class CompactedCursorError extends Schema.TaggedError<CompactedCursorError>()(
  'CompactedCursorError',
  {
    after: Schema.Number,
    floor: Schema.Number,
    cursor: Schema.Number,
    message: Schema.String,
  },
) {}

/** A compaction cursor was not a forward step within the snapshot. */
export class InvalidCompactionError extends Schema.TaggedError<InvalidCompactionError>()(
  'InvalidCompactionError',
  {
    through: Schema.Number,
    message: Schema.String,
  },
) {}

/** The application's authorization policy refused the operation. */
export class OperationRejectedError extends Schema.TaggedError<OperationRejectedError>()(
  'OperationRejectedError',
  {
    opId: Schema.String,
    message: Schema.String,
  },
) {}

/** An operation identity was reused with a different payload or actor. */
export class IdentityConflictError extends Schema.TaggedError<IdentityConflictError>()(
  'IdentityConflictError',
  {
    opId: Schema.String,
    message: Schema.String,
  },
) {}
