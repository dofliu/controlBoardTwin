import asyncio, sys
from playwright.async_api import async_playwright
ARGS=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        pg = await b.new_page(viewport={'width':1440,'height':950})
        errs=[]; pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); pg.on('console', lambda m: m.type=='error' and errs.append('CONSOLE '+m.text))
        await pg.goto('http://localhost:8766/'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='/tmp/claude-0/t/s_config.png')
        for t in ['behavior','code','observe']:
            await pg.click(f'#t-{t}'); await pg.wait_for_timeout(1200); await pg.screenshot(path=f'/tmp/claude-0/t/s_{t}.png')
        print('\n'.join(errs) or 'no errors')
        await b.close()
asyncio.run(main())
