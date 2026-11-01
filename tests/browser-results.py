# Test-only instrumentation is routed into the browser, never shipped in dist.
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
import io

image = Image.new('RGB', (256, 256), (0, 1, 244))
buffer = io.BytesIO()
image.save(buffer, format='PNG')
hooks = '''
paused=true;
window.resultFixture={
 labels(){updateCreativeTeamLabels();return creativeFleet.group.children.map(mesh=>{
  const label=mesh.children.find(c=>c.name.startsWith('traffic-label-'));
  return {visible:label.visible,parentVisible:mesh.visible,width:label.scale.x/(raceTopCamera.camera.right-raceTopCamera.camera.left)*innerWidth,
   order:label.renderOrder};});},
 hide(){creativeFleet.group.children[0].visible=false;},
 outside(){creativeFleet.group.children[1].position.x+=100000;},
 land(){
  chaseRace.finished=false;expired=false;chaseRace.reported=false;chaseRace.dropConfirmed=false;
  chaseRace.windPoints=0;chaseRace.crewPoints=0;
  const pos={x:TARGET_XZ.x+30,y:0,z:TARGET_XZ.z+40};
  raceCar.info=()=>({x:pos.x+300,y:0,z:pos.z+400,speedMps:0});
  onMarkerLanded(pos);
  raceCar.info=()=>({x:0,y:0,z:0,speedMps:0});
  finishChase(true,false,'計測・回収完了');
 },
 noLanding(){chaseRace.finished=false;chaseRace.landingDistance=null;chaseRace.targetLandingDistance=null;finishChase(false,false,'未投下で終了');}
};
document.body.dataset.resultFixture='ready';
'''
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox','--enable-unsafe-swiftshader'])
    for mobile in [False, True]:
        page = browser.new_page(viewport={'width':390 if mobile else 1280,'height':844 if mobile else 900},
            is_mobile=mobile, has_touch=mobile)
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.route('https://cyberjapandata.gsi.go.jp/**',lambda route:route.fulfill(
            status=200,content_type='image/png',body=buffer.getvalue(),headers={'Access-Control-Allow-Origin':'*'}))
        source=Path('dist/game/prototype/main.js').read_text()
        page.route('**/game/prototype/main.js',lambda route:route.fulfill(status=200,content_type='text/javascript',body=source+'\n'+hooks))
        page.goto('http://127.0.0.1:8001/game/prototype/play.html?world=creative&mode=chase')
        page.locator('body[data-result-fixture=ready]').wait_for(timeout=60000)
        labels=lambda:page.evaluate('resultFixture.labels()')
        assert not any(x['visible'] for x in labels())
        page.keyboard.press('o')
        assert not any(x['visible'] for x in labels())
        page.keyboard.press('b')
        page.wait_for_timeout(300)
        before=labels()
        assert len(before)==5 and all(x['visible'] for x in before),before
        assert all(abs(x['width']-34)<.01 and x['order']==18 for x in before)
        page.mouse.move(200,300)
        page.mouse.wheel(0,250)
        page.wait_for_timeout(200)
        assert all(abs(x['width']-34)<.01 for x in labels())
        page.screenshot(path=f'/tmp/hplateau-labels-{mobile}.png')
        page.evaluate('resultFixture.hide();resultFixture.outside()')
        after=labels()
        assert not after[0]['parentVisible'] and not after[1]['visible']
        page.keyboard.press('b')
        assert not any(x['visible'] for x in labels())
        page.evaluate('resultFixture.land()')
        text=page.locator('#result-sub').inner_text()
        assert '合計 1000 点' in text,text
        assert 'マーカーとターゲット中心の距離 50.0m\n着地時の車との距離 500.0m' in text,text
        assert page.locator('.r-landing-distances').evaluate('(el)=>getComputedStyle(el).fontSize')=='12px'
        page.screenshot(path=f'/tmp/hplateau-result-{mobile}.png')
        page.evaluate('resultFixture.noLanding()')
        assert page.locator('.r-landing-distances').count()==0
        assert '車との距離' not in page.locator('#result-sub').inner_text()
        assert not errors,errors
        print('PASS', 'mobile' if mobile else 'desktop', 'top-only labels, fixed size, offscreen/hidden, landing snapshot, unchanged points, no-landing')
        page.close()
    browser.close()
