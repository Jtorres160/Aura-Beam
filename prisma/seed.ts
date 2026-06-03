import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting Database Seeding...");

  // Clean old data
  await prisma.collectionCard.deleteMany({});
  await prisma.collection.deleteMany({});
  await prisma.watchlist.deleteMany({});
  await prisma.scanHistory.deleteMany({});
  await prisma.cardPrice.deleteMany({});
  await prisma.priceHistory.deleteMany({});
  await prisma.card.deleteMany({});
  await prisma.user.deleteMany({});

  console.log("🧹 Cleaned existing database records.");

  // Create Users
  const user = await prisma.user.create({
    data: {
      name: "Ash Ketchum",
      email: "ash@aura.gg",
      username: "AshKetchum",
      role: "ADMIN",
      plan: "PRO",
      scansToday: 12,
    },
  });
  console.log(`👤 Created user: ${user.name}`);

  // Create Cards
  const cardsData = [
    // Pokémon
    {
      name: "Charizard VMAX",
      game: "POKEMON",
      setName: "Darkness Ablaze",
      setCode: "DAA",
      collectorNumber: "020/189",
      rarity: "ULTRA_RARE",
      types: "Fire",
      supertypes: "Pokémon",
      subtypes: "VMAX,Stage 2",
      imageUrl: "https://images.pokemontcg.io/swsh3/20_hires.png",
      thumbnailUrl: "https://images.pokemontcg.io/swsh3/20.png",
      artist: "aKy CG Works",
      description: "Charizard VMAX - Fire type Stage 2 card.",
      price: { market: 89.99, low: 80.0, mid: 88.0, high: 95.0, foil: 110.0 },
    },
    {
      name: "Pikachu VMAX",
      game: "POKEMON",
      setName: "Vivid Voltage",
      setCode: "VV",
      collectorNumber: "188/185",
      rarity: "SECRET_RARE",
      types: "Lightning",
      supertypes: "Pokémon",
      subtypes: "VMAX,Stage 2",
      imageUrl: "https://images.pokemontcg.io/swsh4/188_hires.png",
      thumbnailUrl: "https://images.pokemontcg.io/swsh4/188.png",
      artist: "aKy CG Works",
      description: "Pikachu VMAX - Secret Rare card.",
      price: { market: 24.99, low: 20.0, mid: 24.0, high: 30.0, foil: 35.0 },
    },
    {
      name: "Umbreon VMAX",
      game: "POKEMON",
      setName: "Evolving Skies",
      setCode: "EVS",
      collectorNumber: "215/203",
      rarity: "SECRET_RARE",
      types: "Darkness",
      supertypes: "Pokémon",
      subtypes: "VMAX,Stage 2",
      imageUrl: "https://images.pokemontcg.io/swsh7/215_hires.png",
      thumbnailUrl: "https://images.pokemontcg.io/swsh7/215.png",
      artist: "Teeziro",
      description: "Umbreon VMAX Alternate Art Secret Rare.",
      price: { market: 185.0, low: 165.0, mid: 180.0, high: 210.0, foil: 220.0 },
    },
    // MTG
    {
      name: "Black Lotus",
      game: "MTG",
      setName: "Alpha",
      setCode: "LEA",
      collectorNumber: "233",
      rarity: "MYTHIC",
      types: "Artifact",
      supertypes: "Artifact",
      subtypes: "",
      imageUrl: "https://cards.scryfall.io/large/front/d/a/dada020e-af3d-4c8d-ae2f-ca414b2d354b.jpg",
      thumbnailUrl: "https://cards.scryfall.io/normal/front/d/a/dada020e-af3d-4c8d-ae2f-ca414b2d354b.jpg",
      artist: "Christopher Rush",
      description: "{0}: Sacrifice Black Lotus: Add three mana of any one color.",
      price: { market: 28500.0, low: 25000.0, mid: 28000.0, high: 32000.0, foil: null },
    },
    {
      name: "Force of Will",
      game: "MTG",
      setName: "Alliances",
      setCode: "ALL",
      collectorNumber: "28",
      rarity: "RARE",
      types: "Instant",
      supertypes: "Instant",
      subtypes: "",
      imageUrl: "https://cards.scryfall.io/large/front/d/d/dd7f38f2-7a54-4712-88b7-995c2759f2de.jpg",
      thumbnailUrl: "https://cards.scryfall.io/normal/front/d/d/dd7f38f2-7a54-4712-88b7-995c2759f2de.jpg",
      artist: "Terese Nielsen",
      description: "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost. Counter target spell.",
      price: { market: 148.0, low: 135.0, mid: 145.0, high: 160.0, foil: 350.0 },
    },
    // Yu-Gi-Oh
    {
      name: "Blue-Eyes White Dragon",
      game: "YUGIOH",
      setName: "Legend of Blue Eyes White Dragon",
      setCode: "LOB-001",
      collectorNumber: "001",
      rarity: "ULTRA_RARE",
      types: "Dragon,Normal",
      supertypes: "Monster",
      subtypes: "Light,Level 8",
      imageUrl: "https://images.ygoprodeck.com/images/cards/89631139.jpg",
      thumbnailUrl: "https://images.ygoprodeck.com/images/cards_small/89631139.jpg",
      artist: "Kazuki Takahashi",
      description: "This legendary dragon is a powerful engine of destruction. Virtually invincible, very few have faced this awesome creature and lived to tell the tale.",
      price: { market: 45.0, low: 40.0, mid: 45.0, high: 50.0, foil: null },
    },
    {
      name: "Dark Magician",
      game: "YUGIOH",
      setName: "Starter Deck: Yugi",
      setCode: "SDY-006",
      collectorNumber: "006",
      rarity: "ULTRA_RARE",
      types: "Spellcaster,Normal",
      supertypes: "Monster",
      subtypes: "Dark,Level 7",
      imageUrl: "https://images.ygoprodeck.com/images/cards/46986414.jpg",
      thumbnailUrl: "https://images.ygoprodeck.com/images/cards_small/46986414.jpg",
      artist: "Kazuki Takahashi",
      description: "The ultimate wizard in terms of attack and defense.",
      price: { market: 12.5, low: 10.0, mid: 12.0, high: 15.0, foil: null },
    },
  ];

  // Save Cards & Prices
  const createdCards = [];
  for (const cData of cardsData) {
    const { price, ...cardDetails } = cData;
    const card = await prisma.card.create({
      data: cardDetails,
    });
    createdCards.push({ ...card, originalPrice: price });

    await prisma.cardPrice.create({
      data: {
        cardId: card.id,
        marketPrice: price.market,
        lowPrice: price.low,
        midPrice: price.mid,
        highPrice: price.high,
        foilPrice: price.foil,
        source: card.game === "POKEMON" ? "tcgplayer" : card.game === "MTG" ? "scryfall" : "ygoprodeck",
      },
    });

    // Seed price history entries
    await prisma.priceHistory.createMany({
      data: [
        { cardId: card.id, marketPrice: (price.market ?? 10) * 0.9, recordedAt: new Date(Date.now() - 86400000 * 2) },
        { cardId: card.id, marketPrice: (price.market ?? 10) * 0.95, recordedAt: new Date(Date.now() - 86400000) },
        { cardId: card.id, marketPrice: price.market, recordedAt: new Date() },
      ],
    });
  }
  console.log(`🎴 Seeded ${createdCards.length} cards with live price tables.`);

  // Create Collection
  const collection = await prisma.collection.create({
    data: {
      userId: user.id,
      name: "My Core Collection",
    },
  });
  console.log(`📦 Created collection: ${collection.name}`);

  // Add cards to collection
  const collectionCards = [
    { card: createdCards[0], quantity: 2, condition: "NM" }, // Charizard VMAX
    { card: createdCards[1], quantity: 1, condition: "NM" }, // Pikachu VMAX
    { card: createdCards[3], quantity: 1, condition: "LP" }, // Black Lotus
    { card: createdCards[5], quantity: 3, condition: "NM" }, // Blue-Eyes
    { card: createdCards[6], quantity: 4, condition: "MP" }, // Dark Magician
  ];

  for (const item of collectionCards) {
    await prisma.collectionCard.create({
      data: {
        collectionId: collection.id,
        cardId: item.card.id,
        quantity: item.quantity,
        condition: item.condition,
        notes: "Generated from automated database seeding.",
      },
    });
  }
  console.log("📝 Added cards to collection.");

  // Add Watchlist entries
  await prisma.watchlist.createMany({
    data: [
      { userId: user.id, cardId: createdCards[0].id, alertAbove: 100.0, alertBelow: 75.0 }, // Charizard VMAX
      { userId: user.id, cardId: createdCards[3].id, alertAbove: 30000.0, alertBelow: 27000.0 }, // Black Lotus
    ],
  });
  console.log("👁️ Seeded watchlist items.");

  console.log("🎉 Database seeding complete! Run Prisma Studio or start API to query data.");
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
