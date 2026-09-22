// Dead-simple durable store: the whole world is one JSON document, written
// atomically and debounced. Good enough for v1 and it keeps deployment to
// "one process, one volume". Swap for Postgres when concurrency demands it.

import fs from 'node:fs';
import path from 'node:path';

export function createStore(filePath, defaults) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    data = structuredClone(defaults);
    writeNow(filePath, data);
  }

  let timer = null;
  let dirty = false;

  function flush() {
    if (!dirty) return;
    dirty = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    writeNow(filePath, data);
  }

  function markDirty() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 400);
    timer.unref?.();
  }

  // Never lose a run because the dyno restarted.
  for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit']) {
    process.once(sig, () => {
      flush();
      if (sig !== 'beforeExit') process.exit(0);
    });
  }

  return { get data() { return data; }, markDirty, flush, filePath };
}

function writeNow(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, filePath);
}
