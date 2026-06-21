// afk-core/src/profile/donutsmp/hunger.js
"use strict";

// DonutSMP auto-eat. Self-contained copy (see also freshsmp/hunger.js).
//
// Eats the way mineflayer's own bot.consume() does: a SINGLE use_item via
// bot.activateItem() — mineflayer builds the correct { hand, sequence, rotation }
// packet for the negotiated protocol, with the sequence taken from its coherent,
// monotonically-increasing block-interaction counter (inventory.js).
//
// Two things are deliberately NOT done, because both are known causes of the
// "invalid sequence" kick on DonutSMP (verified against minecraft-data 1.21.11 /
// protocol 774 in test/use_item_eat.test.js):
//   1. We do NOT hand-write the use_item packet ourselves. The 1.21.2+ schema is
//      { hand, sequence, rotation: vec2f } — a raw write that omits `sequence` or
//      `rotation`, or uses the old separate yaw/pitch fields, fails to serialize
//      or sends a sequence the server rejects. Only bot.activateItem() builds it
//      correctly and keeps the shared sequence counter coherent.
//   2. We do NOT send a release (deactivateItem → block_dig status=5). Real
//      eating completes server-side after the food's use duration; the release
//      carries sequence=0, which is *lower* than the use_item we just sent, so
//      the server sees the sequence go backward and kicks for "invalid sequence".
//      mineflayer already clears bot.usingHeldItem on its own (entity_status 9 /
//      heldItemChanged / set_cooldown) with no packet, so no release is needed.
//
// use_item is NOT in the movement-suppression blocklist (only position/flying
// are), so bot.activateItem() flows straight through to the real client write.

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
      // mineflayer builds { hand, sequence, rotation } and bumps the sequence.
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
