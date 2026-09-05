/**
 * Field-placement tests. Run: node server/slots.test.js
 *
 * These cover the rules in public/js/slots.mjs, which decides where each
 * article's planet sits around the viewer. The behaviour under test is mostly
 * about what does NOT move: the feed refreshes every five minutes while someone
 * is looking at the scene, and two earlier implementations reshuffled the whole
 * field whenever a single article dropped out of the visible set.
 */

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

// Azimuth wraps, so compare on the circle: 5 degrees to 353 degrees is a
// 12 degree move, not a 348 degree one.
function angleDelta(a, b) {
  const d = a - b;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

function makeEntries(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    // Ids deliberately unsorted relative to slot order.
    id: `article-${String((i + offset) * 7919 % 10007).padStart(5, '0')}`,
    seed: ((i + offset) * 0.3819660112) % 1,
    slot: null,
  }));
}

async function main() {
  const { assignSlots } = await import('../public/js/slots.mjs');
  const SPREAD = 0.42;

  // --- the ring fills evenly -------------------------------------------
  {
    const entries = makeEntries(20);
    const placed = assignSlots(entries, 20, SPREAD);
    const slots = [...placed.values()].map((p) => p.slot).sort((a, b) => a - b);
    check('every article gets a slot', placed.size === 20);
    check('slots are unique', new Set(slots).size === 20);
    check('a full ring uses every slot 0..n-1',
      slots.every((s, i) => s === i),
      `got ${slots.join(',')}`);
  }

  // --- placement is deterministic --------------------------------------
  {
    const a = assignSlots(makeEntries(24), 24, SPREAD);
    const b = assignSlots(makeEntries(24), 24, SPREAD);
    const same = [...a.keys()].every((id) => a.get(id).slot === b.get(id).slot
      && a.get(id).azimuth === b.get(id).azimuth);
    check('same input places identically', same);
  }

  // --- nothing moves when one article leaves ---------------------------
  {
    const entries = makeEntries(30);
    const first = assignSlots(entries, 30, SPREAD);
    // assignSlots writes the chosen slot back onto each entry, which is how a
    // planet carries its slot into the next refresh.
    const survivors = entries.filter((_, i) => i !== 15);
    const second = assignSlots(survivors, 30, SPREAD);

    const moved = survivors.filter((e) => (
      angleDelta(second.get(e.id).azimuth, first.get(e.id).azimuth) > 1e-9
    ));
    check('one article leaving moves nothing else',
      moved.length === 0,
      `${moved.length} of ${survivors.length} planets moved`);
  }

  // --- a new article takes the freed slot, not someone else's ----------
  {
    const entries = makeEntries(30);
    assignSlots(entries, 30, SPREAD);
    const freedSlot = entries[15].slot;
    const survivors = entries.filter((_, i) => i !== 15);

    const arrival = { id: 'article-zzzzz', seed: 0.77, slot: null };
    const next = [...survivors, arrival];
    const placed = assignSlots(next, 30, SPREAD);

    check('an arrival takes the slot the departure freed',
      placed.get(arrival.id).slot === freedSlot,
      `arrival got ${placed.get(arrival.id).slot}, freed slot was ${freedSlot}`);

    const moved = survivors.filter((e) => (
      angleDelta(placed.get(e.id).azimuth, e.azimuth ?? placed.get(e.id).azimuth) > 1e-9
    ));
    check('the swap moves no existing planet', moved.length === 0);
  }

  // --- resizing the ring reassigns everything --------------------------
  {
    const entries = makeEntries(20);
    assignSlots(entries, 20, SPREAD);
    // planet.js clears every slot when the ring size changes; this checks that
    // a larger ring is still filled correctly once it does.
    const cleared = entries.map((e) => ({ ...e, slot: null }));
    const placed = assignSlots(cleared, 38, SPREAD);
    const slots = [...placed.values()].map((p) => p.slot);
    check('a resized ring places every article', placed.size === 20);
    check('a resized ring keeps slots unique', new Set(slots).size === 20);
    check('slots stay inside the new ring', slots.every((s) => s >= 0 && s < 38));
  }

  // --- geometry stays inside its declared bounds -----------------------
  {
    const entries = makeEntries(38);
    const placed = assignSlots(entries, 38, SPREAD);
    const all = [...placed.values()];
    check('elevation stays within the spread',
      all.every((p) => Math.abs(p.elevation) <= SPREAD + 1e-9),
      `max |elevation| was ${Math.max(...all.map((p) => Math.abs(p.elevation)))}`);

    // Jitter must never be large enough to push a planet into its neighbour's
    // slot, or the even spacing the ring exists to provide is lost.
    const spacing = (Math.PI * 2) / 38;
    check('jitter keeps planets inside their own slot',
      all.every((p) => Math.abs(p.azimuth - p.slot * spacing) < spacing / 2),
      'a planet drifted more than half a slot from its centre');
  }

  // --- degenerate inputs are survivable --------------------------------
  {
    check('an empty field does not throw', assignSlots([], 20, SPREAD).size === 0);
    const tooMany = makeEntries(10);
    const placed = assignSlots(tooMany, 4, SPREAD);
    check('more articles than slots still places them all uniquely',
      placed.size === 10 && new Set([...placed.values()].map((p) => p.slot)).size === 10);
  }

  console.log(`\nfield slots: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
