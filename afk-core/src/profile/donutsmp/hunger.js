// afk-core/src/profile/donutsmp/hunger.js
"use strict";

// DonutSMP auto-eat.
//
// THE REAL CAUSE OF THE "invalid sequence" KICK ON DONUTSMP
// --------------------------------------------------------
// It was never the use_item packet's shape (that was fixed long ago — we go
// through bot.activateItem(), which builds the correct { hand, sequence,
// rotation } and advances mineflayer's monotonic block-interaction counter, and
// we never send a backward-sequence release). The kick still fired because of
// HOW DonutSMP freezes movement.
//
// DonutSMP's anti-cheat runs a per-tick ping/transaction stream (~20/s — see
// keepAlive.js). A real client answers each tick with a movement packet, so the
// server can place every interaction in a transaction window. DonutSMP's
// movement.js deliberately BLOCKS all `position`/`flying` to look perfectly
// still (anti-detection). While the bot is just standing there that's fine —
// there's no sequenced interaction to validate. But the instant we eat, the
// use_item carries a `sequence` the anti-cheat tries to slot into its per-tick
// transaction stream — and there is no movement rhythm to slot it against, so it
// rejects the interaction as "invalid sequence". This is exactly the failure
// FreshSMP hit (fixed there with per-tick `flying`); the difference is FreshSMP
// sends that rhythm always, DonutSMP stays frozen.
//
// FIX: keep the vanilla idle-movement rhythm alive ONLY for the duration of an
// eat — send `flying` (~20/s, no position change) via origWrite so it bypasses
// the movement-suppression proxy — then stop and re-freeze. The use_item now
// lands inside a valid transaction window. Outside of eating the bot stays
// frozen, preserving the anti-detection posture.

// Safe food items to auto-eat. Dangerous items (pufferfish, spider_eye,
// rotten_flesh, poisonous_potato) are intentionally excluded.
const BOT_FOOD_ITEMS = new Set([
  "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
  "cooked_rabbit", "cooked_cod", "cooked_salmon",
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
  "bread", "cookie", "pumpkin_pie",
  "apple", "golden_apple", "enchanted_golden_apple",
  "carrot", "golden_carrot", "melon_slice",
  "baked_potato", "potato", "beetroot",
  "sweet_berries", "glow_berries",
  "tropical_fish", "dried_kelp",
  "honey_bottle",
  "mushroom_stew", "beetroot_soup", "rabbit_stew",
  "chorus_fruit",
]);

const EAT_THRESHOLD = 18;          // start eating below this (1 full bar lost)
const EAT_HOLD_MS = 2100;          // wait past the slowest food (honey, ~2.0s)
const EAT_COOLDOWN_MS = 1800;      // min gap between eats (> one full eat cycle)
const EAT_EQUIP_SETTLE_MS = 150;   // let the server ack the held-slot change
const MOVE_TICK_MS = 50;           // vanilla per-tick movement cadence (~20/s)

function attachHunger(bot, entry) {
  let isEating = false;
  let eatCooldownUntil = 0;

  const isCurrent = () => entry.bot === bot && !bot._client?.ended;

  // Per-tick `flying` rhythm, on only while we eat. Uses origWrite so it isn't
  // dropped by the movement-suppression proxy (which blocks `flying`).
  function startMovementRhythm() {
    const origWrite = entry._donutOrigWrite;
    if (!origWrite) return null; // can't bypass the proxy → no rhythm available
    const timer = setInterval(() => {
      if (!isCurrent() || bot._client?.state !== "play") return;
      try {
        const onGround = (bot.entity && typeof bot.entity.onGround === "boolean")
          ? bot.entity.onGround : true;
        origWrite("flying", { flags: { onGround, hasHorizontalCollision: false } });
      } catch {
        /* session closing — ignore */
      }
    }, MOVE_TICK_MS);
    if (timer.unref) timer.unref();
    return timer;
  }

  async function tryEat() {
    if (isEating || Date.now() < eatCooldownUntil) return;
    if (!isCurrent()) return;
    if (!bot.entity) return; // activateItem() reads bot.entity.yaw/pitch
    if (bot.food >= EAT_THRESHOLD) return;

    const foodItem = bot.inventory.items().find(
      (item) => item && BOT_FOOD_ITEMS.has(item.name)
    );
    if (!foodItem) return;

    isEating = true;
    let rhythm = null;
    try {
      // Start the movement rhythm BEFORE we touch the hotbar / use the item so
      // the whole interaction (equip + use_item) sits inside a valid transaction
      // window, then give the server a few ticks of rhythm to settle.
      rhythm = startMovementRhythm();

      await bot.equip(foodItem, "hand");
      await new Promise((r) => setTimeout(r, EAT_EQUIP_SETTLE_MS));
      if (!isCurrent() || !bot.entity) return;

      // Single use_item; mineflayer builds { hand, sequence, rotation } and bumps
      // the sequence. Let the server finish the eat after the use duration — no
      // release (a block_dig sequence:0 would jump the sequence backward).
      bot.activateItem();
      await new Promise((r) => setTimeout(r, EAT_HOLD_MS));
      bot.usingHeldItem = false; // clear local "using" flag without a packet

      eatCooldownUntil = Date.now() + EAT_COOLDOWN_MS;
      console.log(`[donutsmp/hunger] 🍖 ${entry.minecraftUser} ate ${foodItem.name} (food: ${bot.food}/20)`);
    } catch (err) {
      console.warn(`[donutsmp/hunger] ⚠️ Eat failed for ${entry.minecraftUser}:`, err.message);
      eatCooldownUntil = Date.now() + 1500;
    } finally {
      if (rhythm) clearInterval(rhythm); // re-freeze: stop sending movement
      isEating = false;
    }
  }

  bot.on("health", () => {
    if (!isCurrent()) return;
    if (bot.food < EAT_THRESHOLD) tryEat().catch(() => {});
  });
}

module.exports = { attachHunger, BOT_FOOD_ITEMS };
