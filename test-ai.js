const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function test() {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at the first image (uploaded). Then look at the following candidate images. Which candidate image matches the uploaded image exactly? Return the 0-indexed index." },
            { type: "image_url", image_url: { url: "https://cards.scryfall.io/large/front/d/e/dea64eb4-9721-4d37-af3a-6f01a3cd37db.jpg?1562744158" } }, // fake uploaded
            { type: "image_url", image_url: { url: "https://cards.scryfall.io/large/front/d/b/db992482-18cb-4676-9d3c-9d180dc3d4bb.jpg?1562744158" } }, // candidate 0
            { type: "image_url", image_url: { url: "https://cards.scryfall.io/large/front/d/e/dea64eb4-9721-4d37-af3a-6f01a3cd37db.jpg?1562744158" } }, // candidate 1 (match)
          ]
        }
      ]
    });
    console.log("Response:", res.choices[0].message.content);
  } catch(e) {
    console.error(e.message);
  }
}
test();
