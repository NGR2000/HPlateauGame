# Run after npm run build and serving dist on port 8001.
# Requires Python Playwright, Pillow and Chromium; remote terrain uses deterministic fixtures.
from playwright.sync_api import sync_playwright
from PIL import Image
import io, json
im=Image.new('RGB',(256,256),(0,1,244)); out=io.BytesIO(); im.save(out,format='PNG'); tile=out.getvalue()
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader'])
 page=b.new_page(viewport={'width':1280,'height':900})
 errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
 page.on('console',lambda m: print('CONSOLE',m.text) if m.type=='error' else None)
 page.route('https://cyberjapandata.gsi.go.jp/**',lambda route:route.fulfill(status=200,content_type='image/png',body=tile,headers={'Access-Control-Allow-Origin':'*'}))
 page.goto('http://127.0.0.1:8001/game/prototype/play.html?dev=1&city=2&road=1')
 page.locator('#area-presets button').first.click(timeout=15000)
 page.locator('#area-btn').click()
 page.locator('#briefing').wait_for(state='visible',timeout=60000)
 page.locator('#flight-time').fill('16:00')
 page.locator('#launch-map').click(position={'x':150,'y':150})
 page.locator('.w-kt').first.fill('151')
 page.locator('#launch-btn').click()
 assert page.locator('#briefing').is_visible()
 assert '150kt' in page.locator('#flight-settings-warning').text_content()
 page.locator('.w-kt').first.fill('3')
 page.locator('#launch-btn').click()
 page.locator('#briefing').wait_for(state='hidden')
 page.wait_for_timeout(1000)
 print('REAL',page.url,'errors',errors)
 assert not errors,errors
 assert 'time=16%3A00' in page.url
 assert page.locator('#area-search').count()==0
 page.goto('http://127.0.0.1:8001/game/prototype/play.html?world=creative&mode=chase')
 page.locator('#loading').wait_for(state='detached',timeout=60000)
 page.wait_for_timeout(3000)
 page.keyboard.down('w');page.wait_for_timeout(1000);page.keyboard.up('w')
 print('CREATIVE speed',page.locator('#race-car-speed').text_content(),'errors',errors)
 assert 'km/h' in page.locator('#race-car-speed').text_content()
 assert not errors,errors
 page.goto('http://127.0.0.1:8001/game/prototype/city-editor.html')
 page.locator('#loading').wait_for(state='hidden',timeout=60000)
 print('EDITOR errors',errors)
 assert not errors,errors
 assert page.request.get('http://127.0.0.1:8001/game/development/play.html').status == 404
 b.close()
