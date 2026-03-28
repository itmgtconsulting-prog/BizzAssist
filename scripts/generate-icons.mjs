import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'icons');

function createSvg(size) {
  const r = Math.round(size * 0.12); // 12% corner radius
  const fontSize = Math.round(size * 0.6);
  const yOffset = Math.round(size * 0.04); // slight visual centering tweak

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#2563eb"/>
  <text x="50%" y="50%" dy="${yOffset}" text-anchor="middle" dominant-baseline="central"
        font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif"
        font-weight="700" font-size="${fontSize}" fill="white">B</text>
</svg>`;
}

async function generate(size) {
  const svg = Buffer.from(createSvg(size));
  const out = join(outDir, `icon-${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log(`Created ${out}`);
}

await generate(192);
await generate(512);
console.log('Done.');
