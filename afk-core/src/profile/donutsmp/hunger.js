// afk-core/src/profile/donutsmp/hunger.js
"use strict";

// DonutSMP auto-eat — minimal version. Eats via origWrite to bypass movement
// suppression proxy, which can interfere with mineflayer's sequence tracking.

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

const EAT_THRESHOLD = 18;
const EAT_HOLD_MS = 2100;
const EAT_COOLDOWN_MS = 1800;

function attachHunger(bot, entry) {
  let isEating = false;
  let eatCooldownUntil = 0;

  const isCurrent = () => entry.bot === bot && !bot._client?.ended;

  async function tryEat() {
    if (isEating || Date.now() < eatCooldownUntil) return;
    if (!isCurrent()) return;
    if (!bot.entity) return;
    if (bot.food >= EAT_THRESHOLD) return;

    const foodItem = bot.inventory.items().find(
      (item) => item && BOT_FOOD_ITEMS.has(item.name)
    );
    if (!foodItem) return;

    isEating = true;
    try {
      const origWrite = entry._donutOrigWrite;
      if (!origWrite) return;

      // Find food slot index (0-35 for inventory, 36-39 for armor, etc)
      let foodSlotIndex = -1;
      for (let i = 0; i < bot.inventory.slots.length; i++) {
        const slot = bot.inventory.slots[i];
        if (slot && slot.name === foodItem.name) {
          foodSlotIndex = i;
          break;
        }
      }
      if (foodSlotIndex < 0) return;

      // Equip to hand slot (0-8) via origWrite
      origWrite("held_item_slot", { slotId: foodSlotIndex });
      await new Promise((r) => setTimeout(r, 50));

      if (!isCurrent()) return;

      // Send use_item via origWrite to bypass movement proxy sequencing issues
      origWrite("use_item", { hand: 0 });
      await new Promise((r) => setTimeout(r, EAT_HOLD_MS));

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
