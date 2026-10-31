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
 def check_views(page):
  page.keyboard.press('b')
  assert page.locator('#tc-top').get_attribute('aria-pressed')=='true'
  assert page.locator('#tc-overview').get_attribute('aria-pressed')=='false'
  page.keyboard.down('w');page.wait_for_timeout(1000);page.keyboard.up('w')
  assert float(page.locator('#race-car-speed').text_content().split()[0])>0
  page.mouse.move(600,400);page.mouse.wheel(0,-200)
  page.wait_for_timeout(300)
  page.screenshot(path='/tmp/hplateau-top-view.png')
  page.keyboard.press('b')
  assert page.locator('#tc-top').get_attribute('aria-pressed')=='false'
  page.keyboard.press('o');page.keyboard.press('b');page.keyboard.press('b')
  assert page.locator('#tc-overview').get_attribute('aria-pressed')=='true'
  page.keyboard.press('b');page.keyboard.press('o')
  assert page.locator('#tc-overview').get_attribute('aria-pressed')=='true'
  assert page.locator('#tc-top').get_attribute('aria-pressed')=='false'
  page.keyboard.press('b');page.keyboard.press('v')
  assert page.locator('#tc-top').get_attribute('aria-pressed')=='false'
  assert page.locator('#tc-overview').get_attribute('aria-pressed')=='false'
 page.goto('http://127.0.0.1:8001/game/prototype/play.html?world=creative&mode=chase')
 page.locator('#loading').wait_for(state='detached',timeout=60000)
 page.wait_for_timeout(3000)
 check_views(page)
 print('CREATIVE speed',page.locator('#race-car-speed').text_content(),'errors',errors)
 assert 'km/h' in page.locator('#race-car-speed').text_content()
 assert not errors,errors
 page.goto('http://127.0.0.1:8001/game/prototype/city-editor.html')
 page.locator('#loading').wait_for(state='hidden',timeout=60000)
 print('EDITOR errors',errors)
 assert not errors,errors
 assert page.request.get('http://127.0.0.1:8001/game/development/play.html').status == 404
 mobile=b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 mobile.on('pageerror',lambda e:errors.append(str(e)))
 mobile.route('https://cyberjapandata.gsi.go.jp/**',lambda route:route.fulfill(status=200,content_type='image/png',body=tile,headers={'Access-Control-Allow-Origin':'*'}))
 mobile.goto('http://127.0.0.1:8001/game/prototype/play.html?world=creative&mode=chase')
 mobile.locator('#loading').wait_for(state='detached',timeout=60000)
 mobile.locator('#mobile-menu > summary').tap();mobile.locator('#tc-top').tap()
 assert not mobile.locator('#mobile-menu').evaluate('(el)=>el.open')
 assert mobile.locator('#tc-top').get_attribute('aria-pressed')=='true'
 cdp=mobile.context.new_cdp_session(mobile)
 forward=mobile.locator('#tc-car-forward').bounding_box()
 right=mobile.locator('#tc-car-right').bounding_box()
 points=[{'x':r['x']+r['width']/2,'y':r['y']+r['height']/2,'id':i} for i,r in enumerate([forward,right])]
 cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':points})
 mobile.wait_for_timeout(1000)
 cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
 assert float(mobile.locator('#race-car-speed').text_content().split()[0])>0
 mobile.locator('#mobile-menu > summary').tap();mobile.locator('#tc-top').tap()
 assert mobile.locator('#tc-top').get_attribute('aria-pressed')=='false'
 mobile.locator('#mobile-menu > summary').tap();mobile.locator('#tc-overview').tap()
 assert mobile.locator('#tc-overview').get_attribute('aria-pressed')=='true'
 assert not errors,errors
 print('MOBILE top view, menu and touch driving passed')
 b.close()
