// afk-core/src/profile/donutsmp/hunger.js
"use strict";

// DonutSMP auto-eat — minimal and defensible.
//
// Eat with a SINGLE use_item via bot.activateItem(). mineflayer builds the
// correct { hand, sequence, rotation } packet for the negotiated protocol and
// advances its own monotonic block-interaction sequence counter. We never send
// a release (deactivateItem -> block_dig sequence:0): that backward jump in the
// sequence is itself rejected as "invalid sequence", and real eating completes
// server-side after the food's use duration anyway (mineflayer clears
// bot.usingHeldItem on its own via entity_status / heldItemChanged, no packet).
//
// NOTE: this is intentionally the plain baseline. An earlier experiment sent
// per-tick "movement rhythm" during the eat to try to dodge a DonutSMP "invalid
// sequence" kick; it was speculative and unverified, so it's been removed.
// Diagnose the real kick reason first (it's now logged in verification.js) before
// layering behaviour on top of the eat.

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

function attachHunger(bot, entry) {
  let isEating = false;
  let eatCooldownUntil = 0;

  const isCurrent = () => entry.bot === bot && !bot._client?.ended;

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
    try {
      await bot.equip(foodItem, "hand");
      // Let the server ack the held-slot change before we start interacting.
      await new Promise((r) => setTimeout(r, EAT_EQUIP_SETTLE_MS));
      if (!isCurrent() || !bot.entity) return;

      // Single use_item; let the server finish the eat after the use duration.
      bot.activateItem();
      await new Promise((r) => setTimeout(r, EAT_HOLD_MS));
      bot.usingHeldItem = false; // clear local "using" flag without a packet

      eatCooldownUntil = Date.now() + EAT_COOLDOWN_MS;
      console.log(`[donutsmp/hunger] 🍖 ${entry.minecraftUser} ate ${foodItem.name} (food: ${bot.food}/20)`);
    } catch (err) {
      console.warn(`[donutsmp/hunger] ⚠️ Eat failed for ${entry.minecraftUser}:`, err.message);
      eatCooldownUntil = Date.now() + 1500;
    } finally {
      isEating = false;
    }
  }

  bot.on("health", () => {
    if (!isCurrent()) return;
    if (bot.food < EAT_THRESHOLD) tryEat().catch(() => {});
  });
}

module.exports = { attachHunger, BOT_FOOD_ITEMS };
