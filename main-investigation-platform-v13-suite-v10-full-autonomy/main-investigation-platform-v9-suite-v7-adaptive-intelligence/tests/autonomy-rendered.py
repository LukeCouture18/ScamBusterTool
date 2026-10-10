"""Real passive content scanner on rendered fixtures. Chrome API transport shim, NOT installed extension."""
import asyncio, base64, json, os, struct, sys, zlib
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
LOGGER=ROOT/'integrations'/'crypto-wallet-logger-v08'
sys.path.insert(0,str(LOGGER/'tests'/'tools'))
from qrcodegen import QrCode

def png(text):
    qr=QrCode.encode_text(text,QrCode.Ecc.MEDIUM);scale=6;border=4;side=(qr.get_size()+border*2)*scale
    raw=b''.join(b'\0'+bytes(0 if border<=x//scale<qr.get_size()+border and border<=y//scale<qr.get_size()+border and qr.get_module(x//scale-border,y//scale-border) else 255 for x in range(side)) for y in range(side))
    def chunk(k,v):return struct.pack('>I',len(v))+k+v+struct.pack('>I',zlib.crc32(k+v)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',side,side,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')

async def main():
    cfg=json.loads(Path(sys.argv[1]).read_text());results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        for c in cfg:
            context=await browser.new_context();page=await context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            async def route(r):
                html=c['html']
                if c.get('qr'):html=html.replace('QR_IMAGE','data:image/png;base64,'+base64.b64encode(png(c['qr'])).decode())
                await r.fulfill(status=200,content_type='text/html',body=html)
            await page.route('**/*',route)
            await page.add_init_script("window.__captures=[];window.chrome={dom:{openOrClosedShadowRoot:e=>e.shadowRoot},runtime:{onMessage:{addListener:()=>{}},sendMessage:async m=>{window.__captures.push(m);return {};}}};")
            await page.goto('https://'+c['domain']+'/deposit')
            for script in ['wallet-core.js','vendor/jsQR.js','qr-scanner.js','content.js']:
                file=LOGGER/script
                if file.exists():await page.evaluate(file.read_text())
            await page.wait_for_timeout(1100)
            actions=[]
            if c.get('click'):
                await page.get_by_role('button',name=c['click'],exact=True).click();actions.append({'action':'normal site interaction','control':c['click']})
                await page.wait_for_timeout(1100)
            if c.get('restart'):
                await context.close();context=await browser.new_context();page=await context.new_page()
                await page.route('**/*',route);await page.add_init_script("window.__captures=[];window.chrome={dom:{openOrClosedShadowRoot:e=>e.shadowRoot},runtime:{onMessage:{addListener:()=>{}},sendMessage:async m=>{window.__captures.push(m);return {};}}};")
                await page.goto('https://'+c['domain']+'/deposit')
                for script in ['wallet-core.js','vendor/jsQR.js','qr-scanner.js','content.js']:
                    if (LOGGER/script).exists():await page.evaluate((LOGGER/script).read_text())
                await page.wait_for_timeout(1100)
            messages=await page.evaluate('window.__captures')
            observations=[w['observation'] for m in messages if m.get('type')=='SAVE_WALLETS' for w in m.get('wallets',[]) if w.get('observation')]
            results.append({'domain':c['domain'],'observations':observations,'human_browsing_actions':actions,'page_errors':errors})
            await context.close()
        await browser.close()
    print(json.dumps({'results':results,'scope':'Rendered real content.js with Chrome message transport shim; installed extension lifecycle not exercised.'}))
asyncio.run(main())
