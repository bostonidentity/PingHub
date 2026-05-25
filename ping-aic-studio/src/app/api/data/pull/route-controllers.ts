// Shared AbortController registry for in-flight pull jobs. Lives in its
// own module so both the start-pull POST and the resume POST can register
// + look up controllers without a circular import via route.ts.
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
