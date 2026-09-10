import { Schema } from 'effect'

/** The persisted storage could not be read or written. */
export class StorageError extends Schema.TaggedError<StorageError>()('StorageError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The storage holds a different replica's state. */
export class WrongReplicaStorageError extends Schema.TaggedError<WrongReplicaStorageError>()(
  'WrongReplicaStorageError',
  {
    documentId: Schema.String,
    replicaId: Schema.String,
    message: Schema.String,
  },
) {}

/** The persisted replica history is internally inconsistent. */
export class InvalidReplicaHistoryError extends Schema.TaggedError<InvalidReplicaHistoryError>()(
  'InvalidReplicaHistoryError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** A persisted pending operation could not have been produced by this replica. */
export class InvalidOutboxError extends Schema.TaggedError<InvalidOutboxError>()(
  'InvalidOutboxError',
  {
    message: Schema.String,
  },
) {}

/** The server sent a checkpoint older than the replica's cursor. */
export class CheckpointRegressionError extends Schema.TaggedError<CheckpointRegressionError>()(
  'CheckpointRegressionError',
  {
    cursor: Schema.Number,
    checkpointCursor: Schema.Number,
    message: Schema.String,
  },
) {}

/** Committed operations were not contiguous from the replica's cursor. */
export class CommittedOrderError extends Schema.TaggedError<CommittedOrderError>()(
  'CommittedOrderError',
  {
    expected: Schema.Number,
    actual: Schema.Number,
    message: Schema.String,
  },
) {}

/** The server rejected an operation the replica never sent. */
export class ForeignRejectionError extends Schema.TaggedError<ForeignRejectionError>()(
  'ForeignRejectionError',
  {
    opId: Schema.String,
    message: Schema.String,
  },
) {}

/** The replica was closed while work was still being submitted. */
export class ReplicaClosedError extends Schema.TaggedError<ReplicaClosedError>()(
  'ReplicaClosedError',
  {
    message: Schema.String,
  },
) {}

/** The stored replica state targets a protocol or schema version this build does not support. */
export class UnsupportedReplicaVersionError extends Schema.TaggedError<UnsupportedReplicaVersionError>()(
  'UnsupportedReplicaVersionError',
  {
    protocolVersion: Schema.NullOr(Schema.Number),
    schemaVersion: Schema.NullOr(Schema.Number),
    message: Schema.String,
  },
) {}

export type ReplicaError =
  | StorageError
  | WrongReplicaStorageError
  | InvalidReplicaHistoryError
  | UnsupportedReplicaVersionError
  | InvalidOutboxError
  | CheckpointRegressionError
  | CommittedOrderError
  | ForeignRejectionError
  | ReplicaClosedError
