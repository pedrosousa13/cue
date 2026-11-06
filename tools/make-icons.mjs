// Renders extension/icon.svg to the PNG sizes the manifest lists.
//   npm run icons
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../extension/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`
  );
  await page.screenshot({ path: new URL(`../extension/icons/icon-${size}.png`, import.meta.url).pathname, omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
