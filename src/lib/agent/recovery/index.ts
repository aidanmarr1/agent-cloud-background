/**
 * Error recovery subsystem — centralized failure diagnosis, strategy selection,
 * and user notification.
 */

export {
  ErrorRecoveryEngine,
  type RootCause,
  type ToolFailure,
  type DiagnosisResult,
  type RecoveryStrategy,
} from './ErrorRecoveryEngine'

export {
  UserNotifier,
  type NotificationSeverity,
  type UserNotification,
} from './UserNotifier'

export { type RecoveryContext } from './types'
