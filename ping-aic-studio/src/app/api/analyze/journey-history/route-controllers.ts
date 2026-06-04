// Shared AbortController registry for in-flight journey-report jobs, so the
// start, suspend, resume, and abort routes can register/look up controllers
// without a circular import.
const controllers = new Map<string, AbortController>();

export function getController(id: string): AbortController | undefined {
  return controllers.get(id);
}
export function setController(id: string, ctl: AbortController): void {
  controllers.set(id, ctl);
}
export function deleteController(id: string): void {
  controllers.delete(id);
}
