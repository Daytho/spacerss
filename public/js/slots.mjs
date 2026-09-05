/**
 * Slot placement for the planet field.
 *
 * Kept free of three.js and of the DOM so the placement rules can be exercised
 * directly by the test suite — see server/slots.test.js. planet.js supplies the
 * viewport-dependent numbers and applies the results to the scene graph.
 *
 * Planets occupy evenly spaced slots around a ring centred on the viewer.
 * Taking the azimuth straight from an article's random seed clumps badly at
 * this population size: random angles leave crowded arcs next to empty ones.
 *
 * The rule that keeps the scene still is that a planet holds on to whatever
 * slot it already has. Only planets new to the field are given one, and they
 * take the gaps left by articles that have dropped out. The ring therefore
 * stays evenly filled without anything already on screen moving because
 * something else arrived — which matters because the feed refreshes every five
 * minutes while the viewer is looking at it.
 */

const GOLDEN = 0.6180339887;

/**
 * @param entries  [{ id, seed, slot }] — `slot` is the slot this entry already
 *                 holds, or null/undefined for one that needs a new slot.
 * @param total    number of slots in the ring.
 * @param spread   how far above and below the viewer the field reaches, in
 *                 radians of elevation.
 * @returns Map of id -> { slot, azimuth, elevation }
 */
export function assignSlots(entries, total, spread) {
  const ringSize = Math.max(1, Math.floor(total) || 0, entries.length);
  const spacing = (Math.PI * 2) / ringSize;

  const taken = new Set();
  const needsSlot = [];

  for (const entry of entries) {
    const { slot } = entry;
    if (Number.isInteger(slot) && slot >= 0 && slot < ringSize && !taken.has(slot)) {
      taken.add(slot);
    } else {
      needsSlot.push(entry);
    }
  }

  // Deterministic order, so a given set of arrivals always lands the same way.
  needsSlot.sort((a, b) => (a.id < b.id ? -1 : 1));

  let next = 0;
  for (const entry of needsSlot) {
    while (next < ringSize && taken.has(next)) next += 1;
    // ringSize is at least entries.length, so a free slot always exists.
    const slot = next % ringSize;
    taken.add(slot);
    entry.slot = slot;
    next += 1;
  }

  const placed = new Map();
  for (const entry of entries) {
    const { slot } = entry;
    const seed = Number.isFinite(entry.seed) ? entry.seed : 0.5;

    placed.set(entry.id, {
      slot,
      // Jitter each planet within its own slot so the ring does not read as a
      // mechanical grid, but never far enough to reach a neighbour's slot.
      azimuth: slot * spacing + (seed - 0.5) * spacing * 0.55,
      // Golden-ratio sequence for elevation: neighbouring slots land far apart
      // vertically, so the field fills the frame instead of settling into a
      // band across the middle. Hashing the seed alone left the top empty.
      elevation: (((slot * GOLDEN + seed * 0.13) % 1) - 0.5) * 2 * spread,
    });
  }
  return placed;
}
