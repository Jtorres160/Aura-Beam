// Phase 5.18A — P0-1 serve-gate unit checks (pure functions, no DB).
import { memoryServeEligible, buildRecognitionKeys, type RecognitionHit } from "../src/lib/scanner/recognition-memory";

const hit = (game: string, matchedBy: "set-cn" | "name"): RecognitionHit =>
  ({ memory: { game } as any, card: {} as any, matchedBy });

const cases: [string, boolean][] = [
  ["MTG name-hit must NOT serve", memoryServeEligible(hit("MTG", "name")) === false],
  ["POKEMON name-hit must NOT serve", memoryServeEligible(hit("POKEMON", "name")) === false],
  ["MTG set-cn hit serves", memoryServeEligible(hit("MTG", "set-cn")) === true],
  ["POKEMON set-cn hit serves", memoryServeEligible(hit("POKEMON", "set-cn")) === true],
  ["YUGIOH name-hit serves (name IS its key)", memoryServeEligible(hit("YUGIOH", "name")) === true],
  ["unknown game never serves", memoryServeEligible(hit("CHESS", "name")) === false],
  ["keys: CN prefix normalized", buildRecognitionKeys({ game: "POKEMON", name: "Mimikyu ex", setCode: "JTG", collectorNumber: "069/159" })!.primaryKey === "POKEMON|setcn|JTG|069"],
  ["keys: no set/CN falls to name key", buildRecognitionKeys({ game: "MTG", name: "  Hex  Magic " })!.primaryKey === "MTG|name|hex magic"],
];

let fail = 0;
for (const [name, ok] of cases) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
  if (!ok) fail++;
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail);
