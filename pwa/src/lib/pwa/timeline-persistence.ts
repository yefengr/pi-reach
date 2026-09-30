type PersistenceState = {
  epoch: number;
  tail: Promise<void>;
};

const states = new WeakMap<object, PersistenceState>();

function stateFor(owner: object): PersistenceState {
  const existing = states.get(owner);
  if (existing) return existing;
  const state: PersistenceState = { epoch: 0, tail: Promise.resolve() };
  states.set(owner, state);
  return state;
}

export function beginTimelinePersistenceEpoch(owner: object): number {
  const state = stateFor(owner);
  state.epoch += 1;
  return state.epoch;
}

export function currentTimelinePersistenceEpoch(owner: object): number {
  return stateFor(owner).epoch;
}

/** Serializes merge/replace writes and skips work superseded before execution. */
export function enqueueTimelinePersistence(
  owner: object,
  epoch: number,
  operation: () => Promise<void>,
): Promise<boolean> {
  const state = stateFor(owner);
  const previous = state.tail;
  const result = previous
    .catch(() => undefined)
    .then(async () => {
      if (state.epoch !== epoch) return false;
      await operation();
      return true;
    });
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}
