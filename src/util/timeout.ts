/**
 * Shared timeout race (AU-R2): previously two near-identical private copies
 * lived in the vision tier and the watcher, with different timeout messages
 * (`ms` vs `s`). One helper, one message format; the timer is always cleared
 * when the promise settles, so no dangling handle survives either path.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
