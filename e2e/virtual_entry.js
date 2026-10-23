// 瀏覽器端到端測試與示範錄影專用：把虛擬 Uno（avr8js）包成 Web Serial 連接埠，取代 navigator.serial
// 晶片和實體板子一樣一直在執行（不論連接埠是否開啟）；有 Optiboot 時可以用 STK500 上傳新程式。
const { VirtualUno } = require('../tools/vdev/avrsim');
window.DofLabVirtual = {
  install(hexText, opts) {
    opts = opts || {};
    const uno = new VirtualUno(hexText, { bootloader: opts.bootloader || null }); uno.setInput(2, true);
    const port = uno.webSerialPort();
    port.tick = () => { };   // 晶片由下面的計時器推進，開關連接埠不影響
    if (window.__perFrame) window.__perFrame.push(ms => uno.runMs(ms));   // 錄影模式：跟著影片的每一格推進
    else setInterval(() => uno.runMs(10), 10);
    window.__vuno = uno;
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port, getPorts: async () => [port] } });
    return uno;
  }
};
