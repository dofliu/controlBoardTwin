// 產生兩個版本：
//   dist/app.html    Claude 預覽用（函式庫由 CDN 載入，無 <!doctype>）
//   dist/index.html  下載版（完整 HTML，函式庫由 ./vendor/ 載入，可離線在教室使用）
const fs = require('fs'); const path = require('path');
const R = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const core = ['boards', 'breadboard', 'components', 'project', 'netlist', 'behavior', 'engine', 'arm', 'codegen', 'experiments', 'twin', 'session', 'routing', 'autowire'].map(f => R(`src/core/${f}.js`));
const fw = `(function(root){const DL=root.DL=root.DL||{};DL.firmware={unoHex:${JSON.stringify(R('tests/fixtures/DofLabFirmata-uno.hex'))},ino:${JSON.stringify(R('tools/firmware/DofLabFirmata/DofLabFirmata.ino'))}};})(typeof globalThis!=='undefined'?globalThis:this);`;   // 觀測頁用的韌體：Uno 可以直接從瀏覽器上傳
const ui = [R('src/drivers/transport.js'), R('src/drivers/drivers.js'), R('src/drivers/stk500.js'), fw, R('src/ui/models.js'), R('src/ui/scene.js'), R('src/ui/blocks.js'), R('src/ui/app.js'), R('src/ui/observe.js'), R('src/ui/arm.js'), R('src/ui/upload.js'), R('src/ui/record.js'), R('src/ui/teacher.js'), R('src/ui/main.js')];
const js = [...core, ...ui].join('\n;\n').replace(/<\/script/gi, '<\\/script');
const LIBS = {
  cdn: ['https://cdn.jsdelivr.net/npm/three@0.148.0/build/three.min.js', 'https://cdn.jsdelivr.net/npm/blockly@10.4.3/blockly_compressed.js', 'https://cdn.jsdelivr.net/npm/blockly@10.4.3/msg/zh-hant.js'],
  local: ['vendor/three.min.js', 'vendor/blockly_compressed.js', 'vendor/blockly-zh-hant.js']
};
const head = `<title>DofLab</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="DofLab：控制板配置、視覺積木、程式產生與數位孿生同步的教學平台原型">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700;900&display=swap">
<style>
${R('src/ui/styles.css')}
</style>`;
function page(libs, media) { return `${head}\n${R('src/ui/body.html')}\n${libs.map(s => `<script src="${s}"></script>`).join('\n')}\n<script>window.DOFLAB_BLOCKLY_MEDIA = ${JSON.stringify(media)};</script>\n<script>\n${js}\n</script>\n`; }
fs.mkdirSync(path.join(__dirname, 'dist/vendor'), { recursive: true });
// 預覽版不允許下載檔案：移除下載連結，只保留「複製文字」
fs.writeFileSync(path.join(__dirname, 'dist/app.html'), page(LIBS.cdn, 'https://cdn.jsdelivr.net/npm/blockly@10.4.3/media/').replace(/<a class="btn" id="dlJson"[^>]*>[^<]*<\/a>/, '').replace('「下載」在 Claude 預覽中可能無效，請改用複製。', '在預覽中請用「複製文字」保存 JSON。'));
fs.writeFileSync(path.join(__dirname, 'dist/index.html'), `<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${page(LIBS.local, 'vendor/blockly-media/').replace('</style>', '</style>\n</head>\n<body>')}</body>\n</html>\n`);
const nm = p => path.join(__dirname, 'node_modules', p);
fs.copyFileSync(nm('three/build/three.min.js'), path.join(__dirname, 'dist/vendor/three.min.js'));
fs.copyFileSync(nm('blockly/blockly_compressed.js'), path.join(__dirname, 'dist/vendor/blockly_compressed.js'));
fs.copyFileSync(nm('blockly/msg/zh-hant.js'), path.join(__dirname, 'dist/vendor/blockly-zh-hant.js'));
fs.mkdirSync(path.join(__dirname, 'dist/vendor/blockly-media'), { recursive: true });   // 離線版自帶 Blockly 的游標與圖示
for (const f of fs.readdirSync(nm('blockly/media'))) if (!/\.(mp3|ogg|wav)$/.test(f)) fs.copyFileSync(nm('blockly/media/' + f), path.join(__dirname, 'dist/vendor/blockly-media', f));
for (const f of ['pi_bridge.py', 'doflab_server.py']) fs.copyFileSync(path.join(__dirname, 'tools', f), path.join(__dirname, 'dist', f));
for (const f of ['README.md', 'ACCEPTANCE.md']) fs.copyFileSync(path.join(__dirname, f), path.join(__dirname, 'dist', f));   // 下載版附上說明與驗收紀錄
fs.mkdirSync(path.join(__dirname, 'dist/firmware/DofLabFirmata'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'tools/firmware/DofLabFirmata/DofLabFirmata.ino'), path.join(__dirname, 'dist/firmware/DofLabFirmata/DofLabFirmata.ino'));
// 只用 ESP32 DevKit V1 板子的範例程式：不需要 DofLab，用 Arduino IDE 打開就能上傳
{
  for (const f of ['boards', 'breadboard', 'components', 'project', 'netlist', 'behavior', 'engine', 'codegen', 'experiments', 'autowire']) require(path.join(__dirname, 'src/core', f + '.js'));
  const DL = globalThis.DL;
  for (const id of ['board-boot-toggle', 'board-touch-lamp', 'board-two-inputs']) {
    const r = DL.experiments.solved(id, 'esp32doit'); const p = r.project;
    p.behavior.confirmed = { inputs: DL.project.inputsHash(p, DL.codegen.GENERATOR_VERSION), at: 'build' };
    const g = DL.codegen.generate(p); if (!g.ok) throw new Error(id + ' ' + g.blockers.join());
    const dir = path.join(__dirname, 'dist/examples/esp32-devkit-v1', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.ino'), g.code.replace(/^\/\/ 輸入雜湊：.*\n/m, ''));
  }
}
console.log('dist/app.html', (fs.statSync(path.join(__dirname, 'dist/app.html')).size / 1024).toFixed(0) + ' KB');
