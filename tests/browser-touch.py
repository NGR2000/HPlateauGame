# Run after npm run build. Serves only local fixtures through Playwright routing.
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
root=Path('dist').resolve()
html='''<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>button{width:85px;height:90px;touch-action:none}.active{background:blue}</style><script type="importmap">{"imports":{"three":"/game/prototype/vendor/three/build/three.module.js"}}</script></head><body><button id="tc-car-left">左</button><button id="tc-car-right">右</button><button id="tc-car-forward">前進</button><button id="tc-car-reverse">後退</button><script type="module">
import {bindCarControls} from '/game/prototype/touchControls.js';
import {createPlayerCar} from '/game/prototype/playerCar.js';
window.dropPointerRelease=false;
for(const name of ['pointerup','pointercancel','lostpointercapture'])
 window.addEventListener(name,e=>{if(window.dropPointerRelease)e.stopImmediatePropagation();},true);
const input={throttle:0,steer:0};const reset=bindCarControls(input,{recoverRelease:true});
const car=createPlayerCar({getHeight:()=>0});
window.probe={input,reset,car};document.body.dataset.ready='yes';
</script></body></html>'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def serve(route):
  from urllib.parse import urlparse
  path=urlparse(route.request.url).path
  if path=='/input-check':route.fulfill(status=200,content_type='text/html',body=html);return
  f=(root/path.lstrip('/')).resolve()
  assert f.is_relative_to(root)
  route.fulfill(status=200,content_type='text/javascript',body=f.read_bytes())
 page.route('http://127.0.0.1:8001/**',serve)
 page.goto('http://127.0.0.1:8001/input-check');page.locator('body[data-ready=yes]').wait_for()
 cdp=page.context.new_cdp_session(page)
 def point(name,i):
  r=page.locator('#tc-car-'+name).bounding_box();return dict(x=r['x']+r['width']/2,y=r['y']+r['height']/2,id=i)
 left=point('left',1);forward=point('forward',2)
 def touch(kind,points):cdp.send('Input.dispatchTouchEvent',dict(type=kind,touchPoints=points))
 def state():return page.evaluate('({...probe.input,blue:document.querySelector("#tc-car-left").classList.contains("active")})')
 touch('touchStart',[left,forward]);assert state()==dict(throttle=1,steer=-1,blue=True)
 touch('touchEnd',[left]);assert state()==dict(throttle=1,steer=0,blue=False),state()
 touch('touchEnd',[]);assert state()==dict(throttle=0,steer=0,blue=False)
 print('PASS: normal two-finger release clears left while forward remains active')
 touch('touchStart',[left]);touch('touchCancel',[]);assert state()['steer']==0
 print('PASS: touch cancellation clears input')
 # Swallow pointer release events before all input handlers. TouchEvent cleanup
 # must recover only the released finger, including while another is held.
 page.evaluate('window.dropPointerRelease=true')
 touch('touchStart',[left,forward]);touch('touchEnd',[left])
 assert state()==dict(throttle=1,steer=0,blue=False)
 touch('touchEnd',[]);assert state()==dict(throttle=0,steer=0,blue=False)
 print('PASS: missing pointer release callbacks recover from remaining touches')
 touch('touchStart',[forward]);assert state()['steer']==0
 motion=page.evaluate("""()=>{const before=probe.car.info().headingDeg;for(let i=0;i<120;i++)probe.car.update(1/60,probe.input);return {before,after:probe.car.info().headingDeg};}""")
 assert motion['before']==motion['after']
 touch('touchEnd',[])
 print('PASS: forward-only touch drives straight after release recovery')
 page.evaluate('window.dropPointerRelease=false')
 # Two fingers on the same button: lifting one must keep the other active.
 second=dict(left,id=3,x=left['x']+5)
 touch('touchStart',[left,second]);touch('touchEnd',[left]);assert state()['steer']==-1
 touch('touchEnd',[]);assert state()['steer']==0
 touch('touchStart',[left]);page.evaluate("window.dispatchEvent(new Event('pagehide'))")
 assert state()==dict(throttle=0,steer=0,blue=False)
 touch('touchEnd',[])
 print('PASS: same-button multi-touch and page interruption')
 # Keyboard and touch can coexist; ending a touch must not erase held keys.
 page.keyboard.down('a');touch('touchStart',[forward]);touch('touchEnd',[])
 assert state()['steer']==-1 and state()['throttle']==0
 page.keyboard.up('a');assert state()['steer']==0
 # Rotation and returning from a background page clear stale holds.
 touch('touchStart',[left]);page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
 assert state()['steer']==0;touch('touchEnd',[])
 print('PASS: keyboard/touch coexistence and screen rotation')
 # The game's pause button calls this reset routine.
 page.evaluate('probe.reset()');assert state()==dict(throttle=0,steer=0,blue=False)
 print('PASS: the existing pause/reset routine recovers the stuck state')
 assert not errors,errors
 browser.close()
