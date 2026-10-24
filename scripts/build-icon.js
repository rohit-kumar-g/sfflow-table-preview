'use strict';
// Renders media/icon.svg to media/icon.png (256 x 256, the Marketplace icon and the preview
// tab icon). Dev tool only (needs the devDependency @resvg/resvg-js).
//   node scripts/build-icon.js [previewDir]
// With previewDir it also writes 128/32/16 px copies there to check small sizes.

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'media', 'icon.svg'), 'utf8');
const render = size => new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

fs.writeFileSync(path.join(root, 'media', 'icon.png'), render(256));
console.log('media/icon.png (256 px)');

const previewDir = process.argv[2];
if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    for (const size of [128, 32, 16]) {
        fs.writeFileSync(path.join(previewDir, `icon-${size}.png`), render(size));
    }
    console.log('previews in ' + previewDir);
}
