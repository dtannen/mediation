export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
  options: { resolveOnAbort?: boolean } = {},
): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }

    if (signal.aborted) {
      if (options.resolveOnAbort) {
        resolve();
      } else {
        reject(new Error('Aborted'));
      }
      return;
    }

    let timer: NodeJS.Timeout | null = null;

    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', onAbort);
      if (options.resolveOnAbort) {
        resolve();
      } else {
        reject(new Error('Aborted'));
      }
    };

    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
