"""Production account page and crypto/mail modules, rendered with Chrome API transport fixtures."""
import asyncio,json
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1];LOGGER=ROOT/'integrations/crypto-wallet-logger-v08'
MOCK=r"""
window.__actions=[];window.__copied='';
Object.defineProperty(navigator,'clipboard',{value:{writeText:async v=>{window.__copied=v;}}});
const storage={async get(k){return {[k]:JSON.parse(localStorage.getItem(k)||'null')};},async set(values){for(const [k,v] of Object.entries(values))localStorage.setItem(k,JSON.stringify(v));}};
window.__vault=new LoggerAccounts.Vault(storage);
const mail=new LoggerMail.Mail(__vault,async(url,options)=>{
 const path=new URL(url).pathname;
 if(path==='/domains')return Response.json({'hydra:member':[{domain:'mail.example',isActive:true,isPrivate:false}]});
 if(path==='/accounts')return Response.json({id:'mailbox'});
 if(path==='/token')return Response.json({token:'private-mail-token'});
 if(path==='/messages')return Response.json({'hydra:member':[{id:'message-1'}]});
 if(path==='/messages/message-1')return Response.json({subject:'Verification',text:'Your verification code is 123456. https://site.example/verify?token=private-link'});
 throw Error('Unexpected fixture request');
});
window.chrome={tabs:{create:async input=>{__actions.push({action:'open_site',url:input.url});return {id:11};}},runtime:{sendMessage:async m=>{const {action,input}=m;__actions.push({action,id:input.id,mode:input.mode,tabId:input.tabId});try{
 switch(action){case 'list':return await __vault.list();case 'unlock':return await __vault.unlock(input.master);case 'lock':__vault.lock();return {locked:true};case 'prepare':return await __vault.prepare(input);case 'details':return __vault.account(input.id);case 'tabs':{const a=__vault.account(input.id);return {tabs:[{id:11,domain:a.domain}]};}case 'fill':{if(input.tabId!==11)throw Error('Wrong tab');__vault.credentials(input.id,'https://'+__vault.account(input.id).domain);return {filled:input.mode==='code'?1:2,reason:'Filled explicitly; submit yourself.'};}case 'login_completed':return await __vault.update(input.id,{lastSuccessfulLogin:new Date().toISOString(),status:'logged in'});case 'mail_create':return await mail.create(input.id);case 'mail_poll':return await mail.poll(input.id);default:throw Error('Unknown action');}
 }catch(e){return {error:e.message};}}}};
"""
async def main():
    checks=[];errors=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True);context=await browser.new_context(viewport={'width':1280,'height':900});page=await context.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        await context.add_init_script((LOGGER/'account-vault.js').read_text()+(LOGGER/'account-mail.js').read_text()+MOCK)
        async def route(r):
            name=r.request.url.split('/')[-1].split('?')[0]
            if name in ['accounts.html','accounts.js','accounts.css','ui.css']:
                await r.fulfill(status=200,content_type='text/html' if name.endswith('html') else 'text/javascript' if name.endswith('js') else 'text/css',body=(LOGGER/name).read_text())
            else:await r.fulfill(status=200,content_type='text/html',body='<h1>Operator-opened verification fixture</h1>')
        await context.route('https://private-logger.example/**',route);await context.route('https://site.example/**',route)
        await page.goto('https://private-logger.example/accounts.html')
        await expect(page.locator('#workspace')).to_be_hidden();checks.append('locked empty state')
        await page.locator('#master').fill('synthetic master password');await page.get_by_role('button',name='Initialize / Unlock').click();await expect(page.locator('#workspace')).to_be_visible()
        await page.locator('#loginUrl').fill('https://site.example/login');await page.get_by_role('button',name='Prepare / Recover account').click();await expect(page.locator('#status')).to_contain_text('Choose your account purpose')
        await page.locator('#intent').select_option('legitimate_new_account');await page.locator('#notes').fill('private operator note');await page.get_by_role('button',name='Prepare / Recover account').click();await expect(page.locator('#status')).to_contain_text('encrypted')
        selected=await page.locator('#saved').input_value();assert selected
        await page.get_by_role('button',name='Prepare / Recover account').click();await expect(page.locator('#status')).to_contain_text('same prepared account');assert await page.locator('#saved').input_value()==selected;checks.append('explicit intent and same identity recovery')
        await page.locator('#fillLogin').click();await expect(page.locator('#status')).to_contain_text('Select an exact-domain site tab')
        await page.locator('#refreshTabs').click();await expect(page.locator('#targetTab option')).to_have_count(2);await page.locator('#targetTab').select_option('11')
        for button in ['fillSignup','fillLogin']:
            await page.locator('#'+button).click();await expect(page.locator('#status')).to_contain_text('submit yourself')
        await page.locator('#openSite').click();await page.locator('#loginCompleted').click();await expect(page.locator('#saved')).to_contain_text('logged in');checks.append('exact tab selection, explicit fill, open site and coarse login confirmation')
        await page.locator('summary').filter(has_text='Reveal / copy').click();assert await page.locator('#privatePassword').input_value()==''
        await page.locator('#reveal').click();await expect(page.locator('#privatePassword')).to_have_attribute('type','text');password=await page.locator('#privatePassword').input_value();assert len(password)>=28
        for button,field in [('copyUsername','privateUsername'),('copyPassword','privatePassword')]:
            await page.locator('#'+button).click();await expect(page.locator('#status')).to_contain_text('Copied');assert await page.evaluate('__copied')==await page.locator('#'+field).input_value()
        await page.locator('#createMail').click();await expect(page.locator('#status')).to_contain_text('Mailbox ready');await page.locator('#pollMail').click();await expect(page.locator('#code')).to_have_value('123456')
        await page.locator('#messages summary').click();await expect(page.locator('#messages pre')).to_contain_text('verification code')
        await page.locator('#copyCode').click();await expect(page.locator('#status')).to_contain_text('Copied');assert await page.evaluate('__copied')=='123456'
        await page.locator('#fillCode').click();await expect(page.locator('#status')).to_contain_text('submit yourself')
        async with context.expect_page() as opened:await page.locator('#verificationLinks a').click()
        external=await opened.value;await external.wait_for_load_state();assert external.url.startswith('https://site.example/verify?token=');await external.close();checks.append('private reveal/copy, production mailbox parsing, message disclosure, code and operator-opened verification link')
        for width in [375,1024,1280,1600]:
            await page.set_viewport_size({'width':width,'height':900});await page.wait_for_timeout(50);assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
        checks.append('375/1024/1280/1600 widths without overflow')
        encrypted=await page.evaluate('JSON.stringify(localStorage)');assert password not in encrypted and 'private operator note' not in encrypted and 'private-mail-token' not in encrypted
        await page.locator('#lock').click();await expect(page.locator('#workspace')).to_be_hidden();assert await page.locator('#privatePassword').input_value()=='';assert await page.locator('#code').input_value()==''
        await page.locator('#master').fill('wrong but long enough password');await page.get_by_role('button',name='Initialize / Unlock').click();await expect(page.locator('#status')).to_contain_text('Unable to unlock')
        await page.locator('#master').fill('synthetic master password');await page.get_by_role('button',name='Initialize / Unlock').click();await expect(page.locator('#workspace')).to_be_visible();await page.reload();await expect(page.locator('#workspace')).to_be_hidden();checks.append('lock clears secrets; error stays visible; encrypted restart recovery')
        assert not errors,errors;await browser.close()
    result={'ok':True,'checks':checks,'errors':errors,'scope':'Production account UI, real WebCrypto and mailbox parser in rendered Chromium; Chrome messaging/tabs/clipboard/provider transport are fixtures. Fill function and trusted worker boundaries are tested separately; no installed extension certification.'}
    (ROOT/'verification/v10/accounts-ui.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
asyncio.run(main())
