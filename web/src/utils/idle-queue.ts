/**
 * One job per idle period, in the order queued, starting after `load`.
 *
 * For work that must be done before the visitor reaches it but must not land
 * in the page's first long task or under a swipe — e.g. a heading's springs
 * (see <WrittenLines>). Each job is a short task of its own.
 */

const queue: (() => void)[] = [];
let draining = false;

const whenIdle = (run: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 120);
  }
};

const drain = () => {
  const next = queue.shift();
  if (!next) {
    draining = false;
    return;
  }
  whenIdle(() => {
    next();
    drain();
  });
};

/** Queue `job`; the returned function drops it if it has not run yet. */
export const enqueueIdle = (job: () => void): (() => void) => {
  let live = true;
  queue.push(() => {
    if (live) job();
  });
  if (!draining) {
    draining = true;
    if (document.readyState === "complete") drain();
    else window.addEventListener("load", drain, { once: true });
  }
  return () => {
    live = false;
  };
};
