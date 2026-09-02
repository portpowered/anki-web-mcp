/**
 * A route-owned commit lease. Application mutations call this from inside
 * their write transaction so navigation, unmount, or a card epoch change can
 * roll back work that has become obsolete before it commits.
 */
export type OperationGuard = () => boolean;

