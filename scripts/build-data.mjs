// GitHub Action이 주기적으로 실행 → 5개 소스 취합 → repo 루트에 data.json 기록.
// Worker의 검증된 aggregate() 로직을 그대로 재사용(중복 없음).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { aggregate } from "../worker/src/index.js";

const data = await aggregate();
const out = fileURLToPath(new URL("../data.json", import.meta.url));
writeFileSync(out, JSON.stringify(data, null, 2));

const ok = data.stocks_oil?.ndx > 0 && data.yields?.us10y > 0;
console.log(`data.json 기록: ${out}`);
console.log(`  yields=${data.yields?.us10y} ndx=${data.stocks_oil?.ndx} btc=${data.crypto?.btc_usd} errors=${JSON.stringify(data.errors)}`);
if (!ok) {
  console.error("핵심 필드 누락 — 종료코드 1");
  process.exit(1);
}
