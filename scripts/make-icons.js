// Makes the app icons for Android and other phones from public/logo.png:
//   public/icon-512.png            the logo on a transparent square (install prompt, splash screen)
//   public/icon-maskable-512.png   the logo on the school's blue, safe for round/squircle masks
//   public/icon-maskable-192.png
// Run after replacing the logo:  npm run icons
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, resize } from '../server/lib/png.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NAVY = [10, 42, 94]; // #0A2A5E

function canvas(size, fill = null) {
  const rgba = Buffer.alloc(size * size * 4);
  if (fill) for (let i = 0; i < size * size; i++) rgba.set([...fill, 255], i * 4);
  return { width: size, height: size, rgba };
}

// Draws `image` centred on `base` (alpha blending).
function place(base, image) {
  const ox = Math.floor((base.width - image.width) / 2);
  const oy = Math.floor((base.height - image.height) / 2);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const s = (y * image.width + x) * 4;
      const d = ((y + oy) * base.width + (x + ox)) * 4;
      const a = image.rgba[s + 3] / 255;
      const da = base.rgba[d + 3] / 255;
      const out = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        base.rgba[d + c] = out ? Math.round((image.rgba[s + c] * a + base.rgba[d + c] * da * (1 - a)) / out) : 0;
      }
      base.rgba[d + 3] = Math.round(out * 255);
    }
  }
  return base;
}

const logo = decodePng(fs.readFileSync(path.join(PUBLIC, 'logo.png')));
// Maskable icons keep the logo inside the central 80% "safe zone" circle.
const fitted = logo.width > 400 ? resize(logo, 400) : logo;
const any = place(canvas(512), fitted.width > 480 ? resize(fitted, 480) : fitted);
const maskable = place(canvas(512, NAVY), fitted.width > 380 ? resize(fitted, 380) : fitted);

fs.writeFileSync(path.join(PUBLIC, 'icon-512.png'), encodePng(any));
fs.writeFileSync(path.join(PUBLIC, 'icon-maskable-512.png'), encodePng(maskable));
fs.writeFileSync(path.join(PUBLIC, 'icon-maskable-192.png'), encodePng(resize(maskable, 192)));
console.log('Icons written to public/: icon-512.png, icon-maskable-512.png, icon-maskable-192.png');
