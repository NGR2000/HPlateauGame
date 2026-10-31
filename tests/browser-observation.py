# Run against dist on port 8001. Test-only instrumentation stays in the routed
# response; no debug API is added to the shipped game.
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
import io

image = Image.new('RGB', (256, 256), (0, 1, 244))
buffer = io.BytesIO()
image.save(buffer, format='PNG')
instrumentation = '''
paused=true;
let fixtureCar=raceCar.info(), fixtureBalloons=[], transmitted=null;
raceCar.info=()=>fixtureCar;
creativeFleet.observations=()=>fixtureBalloons;
const originalRadioSend=radioObserver.send;
radioObserver.send=(...args)=>{const result=originalRadioSend(...args);if(result)transmitted=result;return result;};
chaseRace.reported=true;
raceAutopilot.crewCard=()=>null;
window.radioFixture={
 feed(time,x,balloons,speed=0){
  fixtureCar={...fixtureCar,x,z:0,speedMps:speed};fixtureBalloons=balloons;
  flightSeconds=time;radioObserver.update(time,fixtureCar,balloons,TARGET_XZ);updateRadioUi();
 },
 competing(){raceAutopilot.crewCard=()=>({kind:'overhead',label:'上空クリアです。',enabled:true});updateRadioUi();},
 clearCrew(){raceAutopilot.crewCard=()=>null;},
 state(){return {pending:radioObserver.pending(),choices:radioObserver.choices(),transmitted,points:chaseRace.windPoints};}
};
document.body.dataset.radioFixture='ready';
'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                args=['--no-sandbox', '--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width':1280, 'height':900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://cyberjapandata.gsi.go.jp/**', lambda route: route.fulfill(
        status=200, content_type='image/png', body=buffer.getvalue(),
        headers={'Access-Control-Allow-Origin':'*'}))
    source = Path('dist/game/prototype/main.js').read_text()
    page.route('**/game/prototype/main.js', lambda route: route.fulfill(
        status=200, content_type='text/javascript', body=source+'\n'+instrumentation))
    page.goto('http://127.0.0.1:8001/game/prototype/play.html?world=creative&mode=chase')
    page.locator('body[data-radio-fixture=ready]').wait_for(timeout=60000)
    page.clock.install()

    def feed(t, x, balloon_x=None, speed=0, name='赤', identity='red'):
        balloons = [] if balloon_x is None else [dict(id=identity, name=name, x=balloon_x, y=100, z=0)]
        page.evaluate('(a)=>radioFixture.feed(...a)', [t, x, balloons, speed])

    def state():
        return page.evaluate('radioFixture.state()')

    for t in range(11):
        feed(t, 600, 620+t)
    assert state()['pending']['mode'] == 'near'
    context = page.locator('#radio-context').text_content()
    feed(11, 300, None, speed=1)
    page.evaluate('radioFixture.competing()')
    assert page.locator('#radio-context').text_content() == context
    assert page.locator('#chase-report-quick').is_disabled()
    assert page.locator('#radio-balloon').is_disabled()
    feed(12, 300)
    page.locator('#chase-report-quick').click()
    report = state()['transmitted']
    assert report['mode'] == 'near' and report['x'] == 625 and report['vx'] == 1
    assert state()['points'] == 20
    page.evaluate('radioFixture.clearCrew()')
    for t in range(13, 33):
        feed(t, 300, 500+t-13)
    assert state()['pending'] is None
    assert '19/20ゲーム秒' in page.locator('#radio-context').text_content()
    feed(33, 300, 520)
    assert state()['pending']['mode'] == 'target'
    page.locator('#chase-report-quick').click()
    assert state()['points'] == 40
    feed(34, 300, 521)
    assert state()['choices'] == []
    feed(35, 600, 620)
    assert state()['choices'] == []
    # Another aircraft has its own quota, with no waiting or travel requirement.
    for t in range(36, 56):
        feed(t, 300, 500+t-36, name='青', identity='blue')
    feed(56, 300, 520, name='青', identity='blue')
    assert state()['pending']['id'] == 'blue'
    page.clock.fast_forward(15001)
    assert state()['pending'] is None
    assert state()['points'] == 40
    for t in range(57, 78):
        feed(t, 300, 530, name='青', identity='blue')
    assert state()['pending']['id'] == 'blue'
    page.locator('#chase-report-quick').click()
    assert state()['points'] == 60
    assert not errors, errors
    print('RADIO: two areas, independent aircraft, captured send, moving hold, competing request and expiry passed')
    browser.close()
