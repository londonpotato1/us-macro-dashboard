// 로컬 검증: 배포 전 실데이터로 aggregate() 출력 확인 (node 18+ 네이티브 fetch)
//   실행:  node worker/test-local.mjs
import { aggregate } from "./src/index.js";

const data = await aggregate();
console.log(JSON.stringify(data, null, 2));

// 간단 sanity 체크
const num = (x) => typeof x === "number" && !isNaN(x);
const checks = [
  ["yields.us10y", num(data.yields?.us10y) && data.yields.us10y > 0 && data.yields.us10y < 10],
  ["crypto.btc_usd", num(data.crypto?.btc_usd) && data.crypto.btc_usd > 1000],
  ["stocks_oil.ndx", num(data.stocks_oil?.ndx) && data.stocks_oil.ndx > 0],
  ["stocks_oil.wti", num(data.stocks_oil?.wti) && data.stocks_oil.wti > 0],
  ["fed.zero_cuts_prob", num(data.fed?.zero_cuts_prob) && data.fed.zero_cuts_prob > 0 && data.fed.zero_cuts_prob <= 1],
];
console.log("\n--- sanity ---");
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "OK " : "FAIL"}  ${name}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed · errors: ${JSON.stringify(data.errors)}`);
